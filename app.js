//build express app, register global middleware and routes, and export the app for use in server.js

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const requestLogger = require('./middleware/requestLogger');
const routes = require('./routes');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');

const app = express();
  app.set('etag', false);
  app.set('trust proxy', 1); //added trust proxy 

const INSTANCE_ID = process.env.INSTANCE_ID || `port-${process.env.PORT || 3000}`;
app.use((req, res, next) => {
  res.setHeader('X-Served-By', INSTANCE_ID);
  next();
});

// 1. Global middleware (runs on every request)
app.use(helmet({ contentSecurityPolicy: false })); // CSP off so our inline-script demo page works
app.use(cors());
app.use(requestLogger);
app.use(express.json());           // parses JSON request bodies into req.body
app.use(express.static('public')); // serves index.html

// 2. Routes
app.use('/api', routes);

// 3. These two MUST be last
app.use(notFound);
app.use(errorHandler);

module.exports = app;