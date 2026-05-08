/**
 * Pagination Middleware
 * Enforces safe defaults and maximum limits on pagination parameters
 */

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

function enforcePagination(req, res, next) {
  let { page, limit, per_page, pageSize } = req.query;

  const rawLimit = limit || per_page || pageSize;
  const parsedLimit = parseInt(rawLimit, 10);
  const parsedPage = parseInt(page, 10);

  req.query.limit = (!parsedLimit || parsedLimit < 1)
    ? DEFAULT_PAGE_SIZE
    : Math.min(parsedLimit, MAX_PAGE_SIZE);

  req.query.page = (!parsedPage || parsedPage < 1) ? 1 : parsedPage;

  next();
}

module.exports = { enforcePagination, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE };
