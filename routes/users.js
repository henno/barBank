const router = require('express').Router();
const User = require('../models/User')
const Account = require('../models/Account')
const bcrypt = require('bcrypt')
const {verifyToken} = require('../middlewares')
const userModel = require('../models/User')
const accountModel = require('../models/Account')


router.post('/', async (req, res, next) => {

    // Make sure the password is supplied
    if (typeof req.body.password === "undefined" || req.body.password.length < 8) {
        res.status(400).send({error: "Invalid password"})

        // Stop the execution
        return
    }

    // Hash the password
    req.body.password = await bcrypt.hash(req.body.password, 10);


    try {

        // Create new user to DB
        const user = await new User(req.body).save()

        // Create new account for the user
        const account = await new Account({userId: user.id}).save()

        // Return user to client
        res.status(201).send({
            id: user.id,
            name: user.name,
            username: user.username,
            accounts: [account]
        })

    } catch (e) {

        // Catch duplicate username attempts
        if (/E11000.*username.* dup key.*/.test(e.message)) {
            res.status(400).send({error: 'Username already exists'})

            // Stop the execution
            return
        }

        // Handle other errors
        res.status(409).send({error: e.message})
    }

})

router.get('/current', verifyToken, async (req, res, next) => {

    // Get user object from DB
    const user = await userModel.findOne({_id: req.userId})

    // Get user's accounts
    const accounts = await accountModel.find({userId: req.userId})

    res.status(200).json({
        id: user.id,
        name: user.name,
        username: user.username,
        accounts: accounts
    })
})

module.exports = router;