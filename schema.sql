-- npx wrangler d1 execute dev-db-classes --file=./schema.sql --local
-- npx wrangler d1 execute dev-db-classes --command='SELECT * FROM UserHistory' --local
DROP TABLE IF EXISTS products;
CREATE TABLE IF NOT EXISTS products (productid INTEGER PRIMARY KEY, classification TEXT, lastupdated INTEGER);
INSERT INTO products VALUES ('1', 'clothing', 1687240430), ('2', 'food', 1687240430);

DROP TABLE IF EXISTS userhistory;
CREATE TABLE IF NOT EXISTS userhistory (cookie TEXT, productid TEXT, lastvisited INTEGER, PRIMARY KEY (cookie, productid));
INSERT INTO userhistory VALUES ('example-cookie', '2', 1687311878), ('example-cookie', '1', 1687311913);
