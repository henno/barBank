const express = require('express');
const app = express();
const usersRoute = require('./routes/users')
const sessionsRoute = require('./routes/sessions')
const mongoose = require('mongoose')
const swaggerUi = require('swagger-ui-express')
const yaml = require('yamljs')
const swaggerDocument = yaml.load('docs/swagger.yaml')

// Copy env variables from .env file to process.env
require('dotenv').config()

// Run middlewares
app.use(express.json())
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument))

// Attach routes
app.use('/users', usersRoute)
app.use('/sessions', sessionsRoute)

mongoose.connect(process.env.DB_CONNECT, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useCreateIndex: true
}, ()=>{
    console.log('Heihoo');
})

app.listen(process.env.PORT, ()=>{
    console.log('listening on http://localhost:'+process.env.PORT);
})