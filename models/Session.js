const mongoose = require("mongoose");

module.exports = mongoose.model('Session', mongoose.Schema({
    userId: {type: mongoose.Schema.Types.ObjectId, ref: 'User'}
}, {
    // Transform _id to id
    toJSON: {
        transform: (docIn, docOut) => {
            docOut.token = docOut._id
            delete docOut._id
            delete docOut.__v
        }
    }
}))