const router = require('express').Router();
const bankModel = require('../models/Bank')
const accountModel = require('../models/Account')
const {verifyToken, refreshBanksFromCentralBank} = require('../middlewares')
const fetch = require('node-fetch')
const transactionModel = require('../models/Transaction')
const userModel = require('../models/User')
const jose = require('node-jose');
const axios = require('axios');
const fs = require('fs')
require('dotenv').config()

router.post('/', verifyToken, async (req, res, next) => {

    let banks = [], statusDetail

    // Get account data from db
    const accountFromObject = await accountModel.findOne({number: req.body.accountFrom})

    // Check that account exists
    if (!accountFromObject) {
        return res.status(404).json({error: 'Account not found'})
    }

    // Check that accountFrom belongs to the user
    if (accountFromObject.userId.toString() !== req.userId.toString()) {
        return res.status(403).json({error: 'Forbidden'})
    }

    // Check for sufficient funds
    if (req.body.amount > accountFromObject.balance) {
        return res.status(402).json({error: 'Insufficient funds'})
    }

    // Check for invalid amounts
    if (req.body.amount <= 0) {
        return res.status(400).json({error: 'Invalid amount'})
    }

    const bankToPrefix = req.body.accountTo.slice(0, 3)
    let bankTo = await bankModel.findOne({bankPrefix: bankToPrefix})

    // Check destination bank
    if (!bankTo) {

        // Refresh banks from central bank
        const result = await refreshBanksFromCentralBank();

        // Check if there was an error
        if (typeof result.error !== 'undefined') {

            // Log the error to transaction
            console.log('There was an error communicating with central bank:')
            console.log(result.error)
            statusDetail = result.error

        } else {

            // Try getting the details of the destination bank again
            bankTo = await bankModel.findOne({bankPrefix: bankToPrefix})

            // Check for destination bank once more
            if (!bankTo) {
                return res.status(400).json({error: 'Invalid accountTo'})
            }

        }

    } else {
        console.log('Destination bank was found in cache');
    }

    // Make new transaction
    console.log('Creating transaction...')
    const transaction = transactionModel.create({
        userId: req.userId,
        amount: req.body.amount,
        currency: accountFromObject.currency,
        accountFrom: req.body.accountFrom,
        accountTo: req.body.accountTo,
        explanation: req.body.explanation,
        statusDetail,
        senderName: (await userModel.findOne({_id: req.userId})).name
    })

    return res.status(201).json()

})

router.post('/b2b', async (req, res, next) => {


    console.log('/b2b: Started processing incoming transaction request')

    let transaction

    // Get jwt from body
    jwt = req.body.jwt

    // Extract transaction from jwt (payload)
    try {

        // Get the middle part of JWT
        const base64EncodedPayload = jwt.split('.')[1];

        // Decode it and parse it to a transaction object
        transaction = JSON.parse(Buffer.from(base64EncodedPayload, 'base64').toString());

        console.log('/b2b: Received this payload: ' + JSON.stringify(transaction))

    } catch (e) {
        return res.status(400).json({error: 'Parsing JWT payload failed: ' + e.message})
    }

    // Extract accountTo
    const accountTo = await accountModel.findOne({number: transaction.accountTo})


    // Verify accountTo
    if (!accountTo) {
        return res.status(404).json({error: 'Account not found'})
    }

    console.log('/b2b: Found this account: ' + JSON.stringify(accountTo))

    // Get bank's prefix from accountFrom
    const bankFromPrefix = transaction.accountFrom.substring(0, 3)
    console.log('/b2b: Prefix of accountFrom is: ' + bankFromPrefix)

    // Get bank's data by prefix
    let bankFrom = await bankModel.findOne({bankPrefix: bankFromPrefix})

    // Update our banks collection, if this is a new bank
    if (!bankFrom) {

        console.log('/b2b: Didn\'t find bankFrom from local bank list')

        // Refresh banks from central bank
        console.log('/b2b: Refreshing local bank list')
        const result = await refreshBanksFromCentralBank();

        // Check if there was an error
        if (typeof result.error !== 'undefined') {

            // Console the error
            console.log('/b2b: There was an error communicating with central bank: ' + result.error)

            // Fail with error
            return res.status(502).json({error: 'Central Bank error: ' + result.error})

        }

        // Try getting the details of the destination bank again
        console.log('/b2b: Attempting to get bank from local bank list again')
        bankFrom = await bankModel.findOne({bankPrefix: bankFromPrefix})

        // Fail with error if the bank is still not found
        if (!bankFrom) {

            console.log('/b2b: Still didn\'t get the bank. Failing now')

            return res.status(400).json({
                error: 'The account sending the funds does not belong to a bank registered in Central Bank'
            })
        }

    }

    console.log('/b2b: Got bank details: ' + JSON.stringify(bankFrom))

    // Get bank's jwksUrl
    if (!bankFrom.jwksUrl) {
        console.log('/b2b: bankFrom does not have jwksUrl: ' + JSON.stringify(bankFrom))
        return res.status(500).json({error: 'Cannot verify your signature: The jwksUrl of your bank is missing'})
    }

    // Get bank's public key
    let keystore
    try {

        // Get the other bank's public key
        console.log(`/b2b: Attempting to contact jwksUrl of ${bankFrom.name}...`)
        const response = await axios.get(bankFrom.jwksUrl);

        // Import it to jose
        console.log('/b2b: Importing its public key to our keystore')
        keystore = await jose.JWK.asKeyStore(response.data)

    } catch (e) {
        console.log(`/b2b: Importing of the other bank's public key from ${bankFrom.jwksUrl} failed: ` + e.message)
        return res.status(400).json({error: `Cannot verify your signature: The jwksUrl of your bank (${bankFrom.jwksUrl}) is invalid: ` + e.message})
    }

    // Verify that the signature matches the payload and it's created with the private key of which we have the public version
    console.log('/b2b: Verifying signature')
    try {
        await jose.JWS.createVerify(keystore).verify(jwt)
    } catch (e) {
        return res.status(400).json({error: 'Invalid signature'})
    }

    // Write original amount to amount
    let amount = transaction.amount

    // Convert amount from another currency, if needed
    if (accountTo.currency !== transaction.currency) {

        console.log('/b2b: Currency needs conversion')

        // Get the currency rate
        const rate = await require('exchange-rates-api')
            .exchangeRates().latest()
            .base(transaction.currency)
            .symbols(accountTo.currency)
            .fetch();

        console.log(`/b2b: Looks like 1 ${transaction.currency} = ${rate} ${accountTo.currency}`)

        // Convert strings to numbers, convert currency, round the result to full cents (makes it a string) and convert it back to number
        amount = parseInt((parseFloat(rate) * parseInt(amount)).toFixed(0))

    }

    // Get accountTo owner's details
    const accountToOwner = await userModel.findOne({_id: accountTo.userId})

    // Increase accountTo's balance
    console.log(`/b2b: Increasing ${accountToOwner.name}'s account ${accountTo.number} by ${amount / 100} ${accountTo.currency}`)
    accountTo.balance = accountTo.balance + amount

    // Save the change to DB
    accountTo.save()


    // Create transaction
    await transactionModel.create({
        userId: accountTo.userId,
        amount: transaction.amount,
        currency: transaction.currency,
        accountFrom: transaction.accountFrom,
        accountTo: transaction.accountTo,
        explanation: transaction.explanation,
        senderName: transaction.senderName,
        receiverName: accountToOwner.name,
        status: 'completed'
    })

    // Send receiverName
    res.json({receiverName: accountToOwner.name})

})

router.get('/', verifyToken, async (req, res, next) => {

    // Get user's transactions
    const transactions = await transactionModel.find({userId: req.userId})

    // Return them
    res.status(200).json(transactions)

})

router.get('/jwks', async (req, res, next) => {

    // Create new keystore
    console.log('/jwks: Creating keystore')
    const keystore = jose.JWK.createKeyStore();

    // Add our private key from file to the keystore
    console.log('/jwks: Reading private key from disk and adding it to keystore')
    await keystore.add(fs.readFileSync('./keys/private.key').toString(), 'pem')

    // Return our keystore (only the public key derived from the imported private key) in JWKS (JSON Web Key Set) format
    console.log('/jwks: Exporting keystore and returning it')
    return res.send(keystore.toJSON())

})

module.exports = router;