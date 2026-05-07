# Test Data Seeding Scripts

Utility scripts that populate the database with predictable users, hosts, and properties for local testing.

## Prerequisites

- Node.js >= 16
- MongoDB connection string available through `MONGODB_URI` or `MONGO_URI` in the backend `.env`

## Available Scripts

### `seed-sample-data.js`

Creates:

1. Two **host** accounts with verified status and location metadata.
2. Two **guest** accounts ready to log in.
3. Three **properties** linked to the hosts, covering villa, cottage, and apartment use cases. Properties include pricing, hourly booking, and imagery to drive frontend flows.

The script is idempotent — rerunning it updates nothing when records already exist (checks by email/title).

## Usage

From the backend project root:

```bash
node scripts/test-data/seed-sample-data.js
```

You should see console output confirming each created or skipped document. On completion, the script closes the Mongo connection automatically.

## Cleanup

To remove the seeded data, delete the users/properties manually or with your favourite MongoDB client (e.g. Compass, `mongosh`).
