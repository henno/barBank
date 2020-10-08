const router = require('express').Router();
//const sessionModel = require('../models/Session')
//const userModel = require('../models/User')
const bankModel = require('../models/Bank')
const accountModel = require('../models/Account')
const {verifyToken} = require('../middlewares')
const fetch = require('node-fetch')
const transactionModel = require('../models/Transaction')
const userModel = require('../models/User')

require('dotenv').config()

router.post('/', verifyToken, async (req, res, next) => {

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
        console.log('Destination bank was not found in cache');
        const banks = await fetch(`${process.env.CENTRAL_BANK_URL}/banks`, {
            headers: {'Api-Key': process.env.CENTRAL_BANK_API_KEY}
        })
            .then(responseText => responseText.json())

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

        // Try getting the details of the destination bank again
        bankTo = await bankModel.findOne({bankPrefix: bankToPrefix})

        // Check for destination bank once more
        if(!bankTo){
            return res.status(400).json({error: 'Invalid accountTo'})
        }

    }else{
        console.log('Destination bank was found in cache');
    }

    // Make new transaction
    const transaction = transactionModel.create({
        userId: req.userId,
        amount: req.body.amount,
        currency: accountFromObject.currency,
        accountFrom: req.body.accountFrom,
        accountTo: req.body.accountTo,
        explanation: req.body.explanation,
        senderName: (await userModel.findOne({_id: req.userId})).name
    })

    return res.status(200).json()

})

module.exports = router;