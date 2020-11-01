const mongoose = require('mongoose');
const sessionModel = require('./models/Session')
const transactionModel = require('./models/Transaction')
const accountModel = require('./models/Account')
const bankModel = require('./models/Bank')
const fetch = require('node-fetch')
const axios = require('axios')
const jose = require('node-jose');
const fs = require('fs');

require('dotenv').config()

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

    let oServerResponse
        , timeout
        , bankTo

    // Init jose keystore
    const privateKey = fs.readFileSync('./keys/private.key').toString()
    const keystore = jose.JWK.createKeyStore();
    const key = await keystore.add(privateKey, 'pem')

    // Get pending transactions
    const pendingTransactions = await transactionModel.find({status: 'pending'})

    // Loop through each transaction and send a request
    pendingTransactions.forEach(async transaction => {

        console.log('loop: Processing transaction...');

        // Calculate transaction expiry time
        transactionExpiryTime = new Date(
            transaction.createdAt.getFullYear(),
            transaction.createdAt.getMonth(),
            transaction.createdAt.getDate()
            + 3);

        if (transactionExpiryTime < new Date) {

            // Set transaction status to failed
            transaction.status = 'failed'
            transaction.statusDetail = 'Timeout reached'
            transaction.save();

            // Go to next transaction
            return
        }

        // Bundle together transaction and its abortController
        const transactionData = {
            transaction: transaction
        }

        // Set transaction status to in progress
        transaction.status = 'inProgress'
        transaction.save();

        let bankPrefix = transaction.accountTo.slice(0, 3);
        bankTo = await bankModel.findOne({bankPrefix})

        let centralBankResult
        if (!bankTo) {
            centralBankResult = exports.refreshBanksFromCentralBank()
        }

        if (typeof centralBankResult !== "undefined" && centralBankResult.error !== 'undefined') {

            console.log('loop: There was an error when tried to reach central bank')
            console.log(centralBankResult.error)

            // Set transaction status back to pending
            transaction.status = 'pending'
            transaction.statusDetail = 'Central bank was down - cannot get destination bank details. More details: ' + centralBankResult.error
            transaction.save();

            // Go to next transaction
            return

        } else {

            // Attempt to get the destination bank after refresh again
            bankTo = await bankModel.findOne({bankPrefix})
        }

        if (!bankTo) {

            console.log('loop: WARN: Failed to get bankTo')
            // Set transaction status failed
            transaction.status = 'failed'
            transaction.statusDetail = 'There is no bank with prefix ' + bankPrefix
            transaction.save();

            // Go to next transaction
            return
        }

        // Create jwt
        const jwt = await jose.JWS.createSign({
            alg: 'RS256',
            format: 'compact'
        }, key).update(JSON.stringify({
            accountFrom: transaction.accountFrom,
            accountTo: transaction.accountTo,
            currency: transaction.currency,
            amount: transaction.amount,
            explanation: transaction.explanation,
            senderName: transaction.senderName
        }), 'utf8').final()

        // Send request to remote bank
        try {

            console.log('loop: Making request to ' + bankTo.transactionUrl);

            const CancelToken = axios.CancelToken;
            const source = CancelToken.source();

            // Abort connection after 1 sec
            timeout = setTimeout(() => {

                console.log('loop: Aborting long-running transaction');

                // Abort the request
                source.cancel('Operation canceled by the user.');

                // Set transaction status back to pending
                transaction.status = 'pending'
                transaction.statusDetail = 'Server is not responding'
                transaction.save();

            }, 2000)

            // Actually send the request
            oServerResponse = await axios.post(bankTo.transactionUrl,
                {jwt},
                {cancelToken: source.token}
            )

        } catch (e) {

            if (axios.isCancel(e)) {
                console.log('loop: Making request to another bank was cancelled due to timeout with the following message: ', e.message);
            } else {
                console.log('loop: Making request to another bank failed with the following message: ' + e.message)
            }

            transaction.status = 'failed'
            transaction.statusDetail = 'The other bank said ' + oServerResponse.data
            transactionData.abortController = null
            transaction.save()
            return
        }

        // Cancel aborting
        clearTimeout(timeout)

        // Log bad responses from server to transaction statusDetail (including missing receiverName property)
        if (oServerResponse.status < 200 || oServerResponse.status >= 300
            || typeof oServerResponse.data.receiverName === 'undefined') {
            console.log('loop: Server response was ' + oServerResponse.status);
            transaction.status = 'failed'
            transaction.statusDetail = typeof oServerResponse.data.error !== 'undefined' ?
                oServerResponse.data.error : JSON.stringify(oServerResponse)
            transaction.save()
            return
        }

        // Add receiverName to transaction
        transaction.receiverName = oServerResponse.data.receiverName

        // Deduct accountFrom
        const account = await accountModel.findOne({number: transaction.accountFrom})
        account.balance = account.balance - transaction.amount
        account.save();

        // Update transaction status to completed
        console.log('loop: Transaction ' + transaction.id + ' completed')
        transaction.status = 'completed'
        transaction.statusDetail = ''

        // Write changes to DB
        transaction.save()

    }, Error())


    // Call same function again after 1 sec
    setTimeout(exports.processTransactions, 1000)

}
/**
 * Refreshes the list of known banks from Central Bank
 * @returns void
 */
exports.refreshBanksFromCentralBank = async () => {

    try {
        let nockScope, nock

        console.log('Refreshing banks');

        // Mock central bank responses in TEST_MODE
        if (process.env.TEST_MODE === 'true') {

            console.log('TEST_MODE=true');
            nock = require('nock')
            nockScope = nock(process.env.CENTRAL_BANK_URL)
                .get('/banks')
                .reply(200,
                    [
                        {
                            "name": "fooBank",
                            "transactionUrl": "http://foobank.com/transactions/b2b",
                            "bankPrefix": "foo",
                            "owners": "John Smith",
                            "jwksUrl": "http://foobank.diarainfra.com/jwks.json"
                        },
                        {
                            "name": "barBank",
                            "transactionUrl": "https://barbank.com/api/external/receive",
                            "bankPrefix": "bar",
                            "owners": "Jane Smith",
                            "jwksUrl": "https://barbank.com/api/external/keys"
                        }
                    ]
                )
        }

        console.log('refreshBanksFromCentralBank: Attempting to contact central bank at ' + `${process.env.CENTRAL_BANK_URL}/banks`)

        banks = await fetch(`${process.env.CENTRAL_BANK_URL}/banks`, {
            headers: {'Api-Key': process.env.CENTRAL_BANK_API_KEY}
        })
            .then(responseText => responseText.json())

        console.log('refreshBanksFromCentralBank: CB response was: ' + JSON.stringify(banks));

        // Delete all old banks
        await bankModel.deleteMany()

        // Create new bulk object
        const bulk = bankModel.collection.initializeUnorderedBulkOp();

        // Add banks to queue to be inserted into DB
        banks.forEach(bank => {
            bulk.insert(bank);
        })

        // Start bulk insert
        await bulk.execute();

    } catch (e) {
        console.log('Failed to communicate with the central bank');
        console.log(e.message);
        return {error: e.message}
    }

    return true

}
