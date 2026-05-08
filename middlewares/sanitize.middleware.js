/**
 * NoSQL Injection Sanitization Middleware
 * Strips MongoDB query operators ($gt, $ne, $regex, etc.) from request inputs
 */

function sanitizeValue(value) {
  if (value === null || value === undefined) return value;
  
  if (typeof value === 'string') return value;
  
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  
  if (typeof value === 'object') {
    const sanitized = {};
    for (const key of Object.keys(value)) {
      if (key.startsWith('$')) {
        continue; // Strip MongoDB operators
      }
      sanitized[key] = sanitizeValue(value[key]);
    }
    return sanitized;
  }
  
  return value;
}

function mongoSanitize(req, res, next) {
  if (req.body) {
    req.body = sanitizeValue(req.body);
  }
  if (req.query) {
    req.query = sanitizeValue(req.query);
  }
  if (req.params) {
    req.params = sanitizeValue(req.params);
  }
  next();
}

module.exports = { mongoSanitize };
