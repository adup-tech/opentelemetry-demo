// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
const {context, propagation, trace, metrics} = require('@opentelemetry/api');
const cardValidator = require('simple-card-validator');
const { v4: uuidv4 } = require('uuid');

const { OpenFeature } = require('@openfeature/server-sdk');
const { FlagdProvider} = require('@openfeature/flagd-provider');
const flagProvider = new FlagdProvider();

const logger = require('./logger');
const tracer = trace.getTracer('paymentservice');
const meter = metrics.getMeter('paymentservice');
const transactionsCounter = meter.createCounter('app.payment.transactions')

module.exports.charge = async request => {
  const span = tracer.startSpan('charge');

  await OpenFeature.setProviderAndWait(flagProvider);
  if (await OpenFeature.getClient().getBooleanValue("paymentServiceFailure", false)) {
    throw new Error("PaymentService Fail Feature Flag Enabled");
  }

  const {
    creditCardNumber: number,
    creditCardExpirationYear: year,
    creditCardExpirationMonth: month
  } = request.creditCard;
  const currentMonth = new Date().getMonth() + 1;
  const currentYear = new Date().getFullYear();
  const lastFourDigits = number.substr(-4);
  const transactionId = uuidv4();

  const card = cardValidator(number);
  const { card_type: cardType, valid } = card.getCardDetails();

  span.setAttributes({
    'app.payment.card_type': cardType,
    'app.payment.card_valid': valid
  });

  if (!valid) {
    throw new Error('Credit card info is invalid.');
  }

  if (!['visa', 'mastercard'].includes(cardType)) {
    throw new Error(`Sorry, we cannot process ${cardType} credit cards. Only VISA or MasterCard is accepted.`);
  }

  if ((currentYear * 12 + currentMonth) > (year * 12 + month)) {
    throw new Error(`The credit card (ending ${lastFourDigits}) expired on ${month}/${year}.`);
  }

  // check baggage for synthetic_request=true, and add charged attribute accordingly
  const baggage = propagation.getBaggage(context.active());
  if (baggage && baggage.getEntry("synthetic_request") && baggage.getEntry("synthetic_request").value === "true") {
    span.setAttribute('app.payment.charged', false);
  } else {
    span.setAttribute('app.payment.charged', true);
  }

  span.end();

  const { units, nanos, currencyCode } = request.amount;
  logger.info({transactionId, cardType, lastFourDigits, amount: { units, nanos, currencyCode }}, "Transaction complete.");
  transactionsCounter.add(1, {"app.payment.currency": currencyCode})

  // TODO(workshop1-js)
  // Please add metrics or change the existing metrics to be able to query for the average request.amount.nanos per request
  // What is the least amount of metrics to achieve this?
  // After making the changes, rebuild and restart the service with `make redeploy service=paymentservice`

  // TODO(workshop1-js-grafana)
  // Please add a new Panel in Grafana that shows the average request.amount.nanos per request

  // TODO(workshop2-js)
  // Add metrics to track potential exceptions

  // TODO(workshop2-js-grafana)
  // Add new panel to the Grafana dashboard that shows the number of exceptions in the service in a meaningful way
  // Add an alert if exception are tracked

  return { transactionId }
}
