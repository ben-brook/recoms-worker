-- npx wrangler d1 execute dev-db-classes --file=./schema.sql --local
-- npx wrangler d1 execute dev-db-classes --command='SELECT * FROM products' --local
-- npx wrangler d1 execute dev-db-classes --command='SELECT * FROM userhistory' --local

-- npx wrangler d1 execute dev-db-classes --file=./schema.sql
-- npx wrangler d1 execute dev-db-classes --command='SELECT * FROM products'
-- npx wrangler d1 execute dev-db-classes --command='SELECT * FROM userhistory'
DROP TABLE IF EXISTS products;
CREATE TABLE IF NOT EXISTS products (productid TEXT PRIMARY KEY, classification TEXT, lastupdated INTEGER);
INSERT INTO products VALUES ('1', 'T-shirt', 1687504467); 
INSERT INTO products VALUES ('2', 'Food', 1687504486); 


DROP TABLE IF EXISTS userhistory;
CREATE TABLE IF NOT EXISTS userhistory (cookie TEXT, productid TEXT, lastvisited INTEGER, PRIMARY KEY (cookie, productid));
INSERT INTO userhistory VALUES ('9d717556-aea9-4d9e-8c55-f0ef54afbee8', '1', 1687502910);
INSERT INTO userhistory VALUES ('9d717556-aea9-4d9e-8c55-f0ef54afbee8', '2', 1687504554);
INSERT INTO userhistory VALUES ('2ba19f07-7afb-4998-b405-22911cfd6609', '2', 1687504573);
