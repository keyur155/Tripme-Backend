/**
 * Swagger / OpenAPI Configuration
 */
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
const { config } = require('./index');

const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'TripMe Backend API',
      version: '1.0.0',
      description: 'Airbnb-like accommodation booking platform API',
      contact: {
        name: 'TripMe Team',
      },
    },
    servers: [
      {
        url: config.isDevelopment
          ? `http://localhost:${config.port}`
          : config.frontendUrl || `https://api.tripme.com`,
        description: config.isDevelopment ? 'Development' : 'Production',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            message: { type: 'string', example: 'Error description' },
            code: { type: 'integer', example: 400 },
          },
        },
        SuccessResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: { type: 'object' },
          },
        },
        PaginatedResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: { type: 'array', items: {} },
            pagination: {
              type: 'object',
              properties: {
                page: { type: 'integer', example: 1 },
                limit: { type: 'integer', example: 10 },
                total: { type: 'integer', example: 100 },
                pages: { type: 'integer', example: 10 },
              },
            },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'Auth', description: 'Authentication endpoints' },
      { name: 'Users', description: 'User management' },
      { name: 'Listings', description: 'Property listings' },
      { name: 'Bookings', description: 'Booking management' },
      { name: 'Payments', description: 'Payment processing' },
      { name: 'Reviews', description: 'Review management' },
      { name: 'Admin', description: 'Admin panel endpoints' },
      { name: 'Health', description: 'Health check' },
    ],
  },
  apis: ['./routes/*.js', './controllers/*.js'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

function setupSwagger(app) {
  if (config.isProduction) {
    return; // Don't expose Swagger in production
  }

  app.use(
    '/api-docs',
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      explorer: true,
      customSiteTitle: 'TripMe API Docs',
    })
  );

  app.get('/api-docs.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });
}

module.exports = { setupSwagger, swaggerSpec };
