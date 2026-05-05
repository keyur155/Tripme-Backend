# TripMe Backend API - Comprehensive Documentation

## Setup

1. **Clone the repository**
2. **Install dependencies:**
   ```bash
   cd backend
   npm install
   ```
3. **Configure environment variables:**
   - Copy `env.example` to `.env` and fill in your credentials.
4. **Start the server:**
   ```bash
   npm start
   # or
   node server.js
   ```
   The backend runs on `http://localhost:5001` by default.

---

# API Endpoints

## Authentication

### Register
- **POST** `/api/auth/register`
- **Body:**
  ```json
  {
    "name": "John Doe",
    "email": "john@example.com",
    "password": "yourpassword",
    "phone": "1234567890"
  }
  ```

### Login
- **POST** `/api/auth/login`
- **Body:**
  ```json
  {
    "email": "john@example.com",
    "password": "yourpassword"
  }
  ```

### Forgot Password
- **POST** `/api/auth/forgot-password`
- **Body:**
  ```json
  {
    "email": "john@example.com"
  }
  ```

### Validate Reset Token
- **GET** `/api/auth/reset-password/:token`
- **Params:**
  - `token` (string, required)

### Reset Password
- **POST** `/api/auth/reset-password/:token`
- **Params:**
  - `token` (string, required)
- **Body:**
  ```json
  {
    "password": "newpassword"
  }
  ```

### Verify Email
- **GET** `/api/auth/verify-email/:token`
- **Params:**
  - `token` (string, required)

### Resend Verification Email
- **POST** `/api/auth/resend-verification`
- **Body:**
  ```json
  {
    "email": "john@example.com"
  }
  ```

---

## User

### Get Profile
- **GET** `/api/user/profile`

### Update Profile
- **PUT** `/api/user/profile`
- **Body:**
  ```json
  {
    "name": "New Name",
    "phone": "9876543210"
  }
  ```

### Submit KYC
- **POST** `/api/user/kyc`
- **Body:**
  ```json
  {
    "kycDocument": "base64string",
    "kycType": "aadhaar|passport|..."
  }
  ```

### Get Wishlist
- **GET** `/api/user/wishlist`

### Notifications
- **GET** `/api/user/notifications`
- **PUT** `/api/user/notifications/:id/read`
- **PUT** `/api/user/notifications/read-all`
- **DELETE** `/api/user/notifications/:id`

### Dashboard & Analytics
- **GET** `/api/user/dashboard`
- **GET** `/api/user/analytics`

### Search Users
- **GET** `/api/user/search?query=...`

### Admin
- **PATCH** `/api/user/admin/:id/status` — Update user status
- **PUT** `/api/user/admin/:id/verify-kyc` — Verify KYC

---

## Coupon

### Validate Coupon
- **POST** `/api/coupon/validate`
- **Body:**
  ```json
  {
    "code": "COUPON2024"
  }
  ```

### Create Coupon
- **POST** `/api/coupon/`
- **Body:**
  ```json
  {
    "code": "COUPON2024",
    "discount": 10,
    "expiry": "2024-12-31"
  }
  ```

### Update Coupon
- **PUT** `/api/coupon/:id`
- **Body:**
  ```json
  {
    "discount": 15
  }
  ```

### Use Coupon
- **POST** `/api/coupon/:id/use`

### Other Coupon Endpoints
- **GET** `/api/coupon/` — All coupons
- **GET** `/api/coupon/my-coupons` — My coupons
- **GET** `/api/coupon/:id` — Coupon by ID
- **DELETE** `/api/coupon/:id` — Delete coupon
- **GET** `/api/coupon/:id/usage` — Coupon usage
- **GET** `/api/coupon/:id/usage-history` — Usage history
- **GET** `/api/coupon/stats/overview` — Stats
- **GET** `/api/coupon/stats/popular` — Popular coupons
- **GET** `/api/coupon/admin/all` — (Admin) All coupons
- **GET** `/api/coupon/admin/expired` — (Admin) Expired
- **GET** `/api/coupon/admin/active` — (Admin) Active
- **PATCH** `/api/coupon/admin/:id/status` — (Admin) Update status
- **POST** `/api/coupon/admin/bulk-create` — (Admin) Bulk create

---

## Review

### Create Review
- **POST** `/api/review/`
- **Body:**
  ```json
  {
    "targetId": "property|service|user|host id",
    "rating": 5,
    "comment": "Great!"
  }
  ```

### Update Review
- **PUT** `/api/review/:id`
- **Body:**
  ```json
  {
    "rating": 4,
    "comment": "Updated comment"
  }
  ```

### Add Host Response
- **POST** `/api/review/:id/response`
- **Body:**
  ```json
  {
    "response": "Thank you!"
  }
  ```

### Report Review
- **POST** `/api/review/:id/report`
- **Body:**
  ```json
  {
    "reason": "Spam"
  }
  ```

### Like/Unlike Review
- **POST** `/api/review/:id/like`
- **DELETE** `/api/review/:id/like`

### Other Review Endpoints
- **GET** `/api/review/properties/:propertyId` — Property reviews
- **GET** `/api/review/services/:serviceId` — Service reviews
- **GET** `/api/review/users/:userId` — User reviews
- **GET** `/api/review/hosts/:hostId` — Host reviews
- **GET** `/api/review/my-reviews` — My reviews
- **GET** `/api/review/:id` — Review by ID
- **DELETE** `/api/review/:id` — Delete review
- **GET** `/api/review/stats/property/:propertyId` — Property stats
- **GET** `/api/review/stats/service/:serviceId` — Service stats
- **GET** `/api/review/stats/host/:hostId` — Host stats
- **GET** `/api/review/pending` — (Admin/Host) Pending
- **PATCH** `/api/review/:id/moderate` — (Admin/Host) Moderate

---

## Support

### Create Ticket
- **POST** `/api/support/tickets`
- **Body:**
  ```json
  {
    "subject": "Issue",
    "description": "Describe your issue"
  }
  ```

### Add Message to Ticket
- **POST** `/api/support/tickets/:id/messages`
- **Body:**
  ```json
  {
    "message": "Your message"
  }
  ```

### Update Ticket
- **PUT** `/api/support/tickets/:id`
- **Body:**
  ```json
  {
    "subject": "Updated subject",
    "description": "Updated description"
  }
  ```

### Other Support Endpoints
- **GET** `/api/support/tickets` — My tickets
- **GET** `/api/support/tickets/:id` — Ticket by ID
- **DELETE** `/api/support/tickets/:id` — Close ticket
- **GET** `/api/support/tickets/:id/messages` — Ticket messages
- **PATCH** `/api/support/tickets/:id/status` — Update status
- **PATCH** `/api/support/tickets/:id/priority` — Update priority
- **GET** `/api/support/categories` — Categories
- **GET** `/api/support/topics` — Topics
- **GET** `/api/support/faq` — FAQ
- **GET** `/api/support/help-articles` — Help articles
- **GET** `/api/support/help-articles/:id` — Help article by ID
- **GET** `/api/support/admin/tickets` — (Admin) All tickets
- **GET** `/api/support/admin/tickets/pending` — (Admin) Pending
- **GET** `/api/support/admin/tickets/open` — (Admin) Open
- **PATCH** `/api/support/admin/tickets/:id/assign` — (Admin) Assign
- **PATCH** `/api/support/admin/tickets/:id/status` — (Admin) Update status
- **POST** `/api/support/admin/faq` — (Admin) Create FAQ
- **PUT** `/api/support/admin/faq/:id` — (Admin) Update FAQ
- **DELETE** `/api/support/admin/faq/:id` — (Admin) Delete FAQ
- **POST** `/api/support/admin/help-articles` — (Admin) Create help article
- **PUT** `/api/support/admin/help-articles/:id` — (Admin) Update help article
- **DELETE** `/api/support/admin/help-articles/:id` — (Admin) Delete help article

---

## Notification

### Get My Notifications
- **GET** `/api/notification/`

### Mark Notification as Read
- **PATCH** `/api/notification/:id/read`

### Mark All as Read
- **PATCH** `/api/notification/read-all`

### Delete Notification
- **DELETE** `/api/notification/:id`

### Other Notification Endpoints
- **GET** `/api/notification/unread` — Unread notifications
- **DELETE** `/api/notification/clear-all` — Clear all
- **GET** `/api/notification/preferences` — Get preferences
- **PUT** `/api/notification/preferences` — Update preferences
- **GET** `/api/notification/types` — Get types
- **POST** `/api/notification/subscribe/:type` — Subscribe
- **DELETE** `/api/notification/subscribe/:type` — Unsubscribe
- **POST** `/api/notification/push-token` — Update push token
- **DELETE** `/api/notification/push-token` — Remove push token
- **POST** `/api/notification/admin/send` — (Admin) Send notification
- **POST** `/api/notification/admin/broadcast` — (Admin) Broadcast
- **GET** `/api/notification/admin/sent` — (Admin) Sent notifications

---

## Service

### Create Service
- **POST** `/api/service/`
- **Body:**
  ```json
  {
    "title": "Service Title",
    "description": "...",
    "price": 100
  }
  ```

### Update Service
- **PUT** `/api/service/:id`
- **Body:**
  ```json
  {
    "title": "Updated Title"
  }
  ```

### Add Availability
- **POST** `/api/service/:id/availability`
- **Body:**
  ```json
  {
    "date": "2024-06-01",
    "slots": ["10:00", "14:00"]
  }
  ```

### Book Service
- **POST** `/api/service/:id/book`
- **Body:**
  ```json
  {
    "date": "2024-06-01",
    "slot": "10:00"
  }
  ```

### Other Service Endpoints
- **GET** `/api/service/` — All services
- **GET** `/api/service/search` — Search
- **GET** `/api/service/categories` — Categories
- **GET** `/api/service/:id` — By ID
- **GET** `/api/service/:id/availability` — Availability
- **GET** `/api/service/my-services` — My services
- **DELETE** `/api/service/:id` — Delete
- **PUT** `/api/service/:id/availability/:availabilityId` — Update availability
- **DELETE** `/api/service/:id/availability/:availabilityId` — Delete availability
- **PATCH** `/api/service/:id/status` — Update status
- **PATCH** `/api/service/:id/visibility` — Update visibility
- **GET** `/api/service/:id/bookings` — Service bookings
- **GET** `/api/service/stats/overview` — Stats
- **GET** `/api/service/stats/revenue` — Revenue
- **GET** `/api/service/stats/popular` — Popular
- **GET** `/api/service/:id/reviews` — Reviews
- **GET** `/api/service/:id/rating` — Rating
- **GET** `/api/service/admin/pending` — (Admin) Pending
- **PATCH** `/api/service/admin/:id/approve` — (Admin) Approve
- **PATCH** `/api/service/admin/:id/reject` — (Admin) Reject

---

## Wishlist

### Create Wishlist
- **POST** `/api/wishlist/`
- **Body:**
  ```json
  {
    "name": "My Wishlist"
  }
  ```

### Add Item to Wishlist
- **POST** `/api/wishlist/:id/items`
- **Body:**
  ```json
  {
    "itemId": "listingId or serviceId"
  }
  ```

### Other Wishlist Endpoints
- **GET** `/api/wishlist/` — My wishlists
- **GET** `/api/wishlist/:id` — By ID
- **PUT** `/api/wishlist/:id` — Update
- **DELETE** `/api/wishlist/:id` — Delete
- **DELETE** `/api/wishlist/:id/items/:itemId` — Remove item
- **GET** `/api/wishlist/:id/items` — Items
- **POST** `/api/wishlist/:id/share` — Share
- **GET** `/api/wishlist/shared/:shareId` — Shared wishlist
- **POST** `/api/wishlist/:id/collaborate` — Add collaborator
- **DELETE** `/api/wishlist/:id/collaborate/:userId` — Remove collaborator
- **GET** `/api/wishlist/stats/overview` — Stats
- **GET** `/api/wishlist/stats/popular-items` — Popular items

---

## Listing

### Create Listing
- **POST** `/api/listing/`
- **Body:**
  ```json
  {
    "title": "Listing Title",
    "description": "...",
    "price": 1000
  }
  ```

### Update Listing
- **PUT** `/api/listing/:id`
- **Body:**
  ```json
  {
    "title": "Updated Title"
  }
  ```

### Add Availability
- **POST** `/api/listing/:id/availability`
- **Body:**
  ```json
  {
    "date": "2024-06-01",
    "available": true
  }
  ```

### Other Listing Endpoints
- **GET** `/api/listing/` — All listings
- **GET** `/api/listing/search` — Search
- **GET** `/api/listing/featured` — Featured
- **GET** `/api/listing/categories` — Categories
- **GET** `/api/listing/locations` — Locations
- **GET** `/api/listing/:id` — By ID
- **GET** `/api/listing/:id/similar` — Similar
- **GET** `/api/listing/:id/availability` — Availability
- **GET** `/api/listing/my-listings` — My listings
- **DELETE** `/api/listing/:id` — Delete
- **POST** `/api/listing/:id/photos` — Upload photos
- **DELETE** `/api/listing/:id/photos/:photoId` — Delete photo
- **PATCH** `/api/listing/:id/photos/:photoId/primary` — Set primary photo
- **PUT** `/api/listing/:id/availability/:availabilityId` — Update availability
- **DELETE** `/api/listing/:id/availability/:availabilityId` — Delete availability
- **PUT** `/api/listing/:id/pricing` — Update pricing
- **PATCH** `/api/listing/:id/status` — Update status
- **PATCH** `/api/listing/:id/visibility` — Update visibility
- **POST** `/api/listing/:id/publish` — Publish
- **POST** `/api/listing/:id/unpublish` — Unpublish
- **GET** `/api/listing/:id/reviews` — Reviews
- **GET** `/api/listing/:id/rating` — Rating
- **POST** `/api/listing/:id/wishlist` — Add to wishlist
- **DELETE** `/api/listing/:id/wishlist` — Remove from wishlist
- **GET** `/api/listing/wishlist` — Wishlisted listings
- **GET** `/api/listing/stats/overview` — Stats
- **GET** `/api/listing/stats/revenue` — Revenue
- **GET** `/api/listing/stats/views` — Views
- **GET** `/api/listing/host/dashboard` — Host dashboard
- **GET** `/api/listing/host/performance` — Host performance
- **GET** `/api/listing/admin/pending` — (Admin) Pending
- **PATCH** `/api/listing/admin/:id/approve` — (Admin) Approve
- **PATCH** `/api/listing/admin/:id/reject` — (Admin) Reject
- **PATCH** `/api/listing/admin/:id/feature` — (Admin) Feature

---

## Booking

### Create Booking
- **POST** `/api/booking/`
- **Body:**
  ```json
  {
    "propertyId": "...",
    "checkIn": "2024-06-01",
    "checkOut": "2024-06-05",
    "guests": 2
  }
  ```

### Update Booking
- **PUT** `/api/booking/:id`
- **Body:**
  ```json
  {
    "checkIn": "2024-06-02"
  }
  ```

### Apply Coupon to Booking
- **POST** `/api/booking/:id/apply-coupon`
- **Body:**
  ```json
  {
    "couponCode": "COUPON2024"
  }
  ```

### Other Booking Endpoints
- **GET** `/api/booking/public/properties/:propertyId/availability` — Property availability
- **GET** `/api/booking/public/services/:serviceId/availability` — Service availability
- **GET** `/api/booking/` — My bookings
- **GET** `/api/booking/host` — Host bookings
- **GET** `/api/booking/:id` — By ID
- **DELETE** `/api/booking/:id` — Cancel
- **PATCH** `/api/booking/:id/status` — Update status
- **POST** `/api/booking/:id/confirm` — Confirm
- **POST** `/api/booking/:id/check-in` — Check in
- **POST** `/api/booking/:id/check-out` — Check out
- **POST** `/api/booking/calculate-price` — Calculate price
- **GET** `/api/booking/stats/overview` — Stats
- **GET** `/api/booking/stats/monthly` — Monthly stats
- **GET** `/api/booking/stats/revenue` — Revenue
- **GET** `/api/booking/guest/upcoming` — Guest upcoming
- **GET** `/api/booking/guest/past` — Guest past
- **GET** `/api/booking/host/pending` — Host pending
- **GET** `/api/booking/host/active` — Host active

---

## Payment

### Process Payment
- **POST** `/api/payment/process`
- **Body:**
  ```json
  {
    "bookingId": "...",
    "amount": 1000,
    "methodId": "..."
  }
  ```

### Add Payment Method
- **POST** `/api/payment/methods`
- **Body:**
  ```json
  {
    "type": "card",
    "details": { "cardNumber": "..." }
  }
  ```

### Process Refund
- **POST** `/api/payment/:paymentId/refund`
- **Body:**
  ```json
  {
    "reason": "Customer request"
  }
  ```

### Other Payment Endpoints
- **POST** `/api/payment/confirm/:paymentId` — Confirm payment
- **POST** `/api/payment/cancel/:paymentId` — Cancel payment
- **GET** `/api/payment/methods` — Get methods
- **PUT** `/api/payment/methods/:methodId` — Update method
- **DELETE** `/api/payment/methods/:methodId` — Delete method
- **POST** `/api/payment/methods/:methodId/set-default` — Set default
- **GET** `/api/payment/` — Payment history
- **GET** `/api/payment/:id` — By ID
- **GET** `/api/payment/booking/:bookingId` — By booking
- **GET** `/api/payment/refunds` — Refund history
- **GET** `/api/payment/refunds/:refundId` — Refund by ID
- **POST** `/api/payment/webhook/stripe` — Stripe webhook
- **POST** `/api/payment/webhook/paypal` — PayPal webhook
- **GET** `/api/payment/stats/overview` — Stats
- **GET** `/api/payment/stats/monthly` — Monthly stats
- **GET** `/api/payment/stats/methods` — Method stats
- **GET** `/api/payment/admin/all` — (Admin) All payments
- **GET** `/api/payment/admin/pending` — (Admin) Pending
- **PATCH** `/api/payment/admin/:paymentId/status` — (Admin) Update status

---

## Notes
- All endpoints return JSON responses.
- For protected routes, always include the JWT token in the `Authorization` header.
- Replace `:id`, `:token`, etc. with actual values.
- Use tools like Postman or cURL for testing.

---

Happy Testing!

Test backend workflow