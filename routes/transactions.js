const router = require('express').Router();
const bankModel = require('../models/Bank')
const accountModel = require('../models/Account')
const {verifyToken, refreshBanksFromCentralBank} = require('../middlewares')
const fetch = require('node-fetch')
const transactionModel = require('../models/Transaction')
const userModel = require('../models/User')

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

module.exports = router;
