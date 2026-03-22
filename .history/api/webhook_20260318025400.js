import { handler } from '../netlify/functions/webhook.js';

export default async function webhook(req, res) {
  const queryStringParameters = req.query || {};
  const rawBody = typeof req.body === 'string'
    ? req.body
    : req.body
      ? JSON.stringify(req.body)
      : null;

  const event = {
    httpMethod: req.method,
    body: rawBody,
    queryStringParameters,
  };

  const result = await handler(event);
  const statusCode = result?.statusCode || 200;
  const body = result?.body || '';

  res.status(statusCode);
  res.setHeader('Content-Type', 'application/json');
  res.send(body);
}
