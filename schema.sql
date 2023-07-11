-- npx wrangler d1 execute dev-db-classes --file=./schema.sql
-- npx wrangler d1 execute dev-db-classes --command='SELECT * FROM products'
-- npx wrangler d1 execute dev-db-classes --command='SELECT * FROM userhistory'
-- npx wrangler d1 execute dev-db-classes --command='SELECT * FROM userminhhs'
-- npx wrangler d1 execute dev-db-classes --command='SELECT * FROM minhhusers'
DROP TABLE IF EXISTS products;
CREATE TABLE IF NOT EXISTS products (productid TEXT PRIMARY KEY, name TEXT, picture TEXT, classification TEXT, lastupdated INTEGER);

DROP TABLE IF EXISTS userhistory;
CREATE TABLE IF NOT EXISTS userhistory (cookie TEXT, productid TEXT, lastvisited INTEGER, PRIMARY KEY (cookie, productid));

DROP TABLE IF EXISTS userminhhs;
CREATE TABLE IF NOT EXISTS userminhhs (cookie TEXT, minhh INTEGER, PRIMARY KEY (cookie, minhh));

DROP TABLE IF EXISTS minhhusers;
CREATE TABLE IF NOT EXISTS minhhusers (minhh INTEGER, usercookie TEXT, PRIMARY KEY(minhh, usercookie));
