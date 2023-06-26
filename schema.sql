-- npx wrangler d1 execute dev-db-classes --file=./schema.sql --local
-- npx wrangler d1 execute dev-db-classes --command='SELECT * FROM products' --local
-- npx wrangler d1 execute dev-db-classes --command='SELECT * FROM userhistory' --local

-- npx wrangler d1 execute dev-db-classes --file=./schema.sql
-- npx wrangler d1 execute dev-db-classes --command='SELECT * FROM products'
-- npx wrangler d1 execute dev-db-classes --command='SELECT * FROM userhistory'
DROP TABLE IF EXISTS products;
CREATE TABLE IF NOT EXISTS products (productid TEXT PRIMARY KEY, classification TEXT, lastupdated INTEGER);

DROP TABLE IF EXISTS userhistory;
CREATE TABLE IF NOT EXISTS userhistory (cookie TEXT, productid TEXT, lastvisited INTEGER, PRIMARY KEY (cookie, productid));
