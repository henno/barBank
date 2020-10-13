const mongoose = require('mongoose');
const sessionModel = require('./models/Session')
const transactionModel = require('./models/Transaction')
const bankModel = require('./models/Bank')
const fetch = require('node-fetch')
const jose = require('node-jose');
const fs = require('fs');
const abortController = require('abort-controller');

exports.verifyToken = async (req, res, next) => {

    // Check Authorization header is provided
    let authorizationHeader = req.header('Authorization')
    if (!authorizationHeader) {
        return res.status(401).json({error: 'Missing Authorization header'})
    }

    // Split Authorization header into an array (by spaces)
    authorizationHeader = authorizationHeader.split(' ')

    // Check Authorization header for token
    if (!authorizationHeader[1]) {
        return res.status(400).json({error: 'Invalid Authorization header format'})
    }
    // Validate token is in mongo ObjectId format to prevent UnhandledPromiseRejectionWarnings
    if (!mongoose.Types.ObjectId.isValid(authorizationHeader[1])) {
        return res.status(401).json({error: 'Invalid token'});
    }

    const session = await sessionModel.findOne({_id: authorizationHeader[1]});
    if (!session) return res.status(401).json({error: 'Invalid token'});

    // Write user's id into req
    req.userId = session.userId

    return next(); // Pass the request to the next middleware
}


exports.processTransactions = async () => {

    let serverResponseAsJson
        , serverResponseAsPlainText
        , serverResponseAsObject
        , timeout


    // Get pending transactions
    const pendingTransactions = await transactionModel.find({status: 'pending'})

    // Loop through each transaction and send a request
    pendingTransactions.forEach(async transaction => {

        console.log('Processing transaction...');


        // Attach a new instance of an abort controller to transaction to be able to cancel long running requests
        transaction.abortController = new abortController()

        // Set transaction status to in progress
        transaction.status = 'inProgress'
        transaction.save();

        const bankTo = await bankModel.findOne({bankPrefix: transaction.accountTo.slice(0, 3)})


        // Create jwt
        const privateKey = fs.readFileSync('./keys/private.key').toString()
        const keystore = jose.JWK.createKeyStore();
        const key = await keystore.add(privateKey, 'pem')
        const jwt = await jose.JWS.createSign({
            alg: 'RS256',
            format: 'compact'
        }, key).update(JSON.stringify(transaction)).final()

        // Send request to remote bank
        try {

            console.log('Making request to ' + bankTo.transactionUrl);

            // Abort connection after 1 sec
            timeout = setTimeout(() => {

                console.log('Aborting long-running transaction');

                // Abort the request
                transaction.abortController.abort()

                // Remove abort controller
                transaction.abortController = null
                console.log(transaction);

                // Set transaction status back to pending
                transaction.status = 'pending'
                transaction.statusDetail = 'Server is not responding'
                transaction.save();

            }, 1000)

            serverResponseAsObject = await fetch(bankTo.transactionUrl, {
                signal: transaction.abortController.signal,
                method: 'POST',
                redirect: 'follow',
                body: JSON.stringify({jwt}),
                headers: {
                    'Content-Type': 'application/json'
                }
            })

            serverResponseAsPlainText = await serverResponseAsObject.text()


            //.then(responseText => responseText.text())


        } catch (e) {
            console.log(e.message);
        }

        // Cancel aborting
        clearTimeout(timeout)

        // Server did not respond (we aborted before that)
        if (typeof serverResponseAsPlainText === 'undefined') {

            // Stop processing this transaction for now and take the next one
            return
        }

        // Attempt to parse server response to JSON
        try {
            serverResponseAsJson = JSON.parse(serverResponseAsPlainText)
        } catch (e) {
            console.log(e.message + ". Response was: " + serverResponseAsPlainText)
            transaction.status = 'failed'
            transaction.statusDetail = 'The other bank said ' + serverResponseAsPlainText
            transaction.abortController = null
            transaction.save()
            return
        }

        console.log(serverResponseAsObject.status);

        // Log bad responses from server to transaction statusDetail
        if (serverResponseAsObject.status < 200 || serverResponseAsObject.status >= 300) {
            console.log('Server response was '+ serverResponseAsObject.status);
            transaction.status = 'failed'
            transaction.statusDetail = typeof serverResponseAsJson.error !== 'undefined' ?
                serverResponseAsJson.error : serverResponseAsPlainText
            transaction.save()
            return
        }

        // Add receiverName to transaction
        transaction.receiverName = serverResponseAsJson.receiverName

        // Update transaction status to completed
        transaction.status = 'completed'
        transaction.statusDetail = ''

        // Remove abort controller
        delete transaction.abortController

        // Write changes to DB
        transaction.save()

    }, Error())


    // Call same function again after 1 sec
    setTimeout(exports.processTransactions, 1000)

}