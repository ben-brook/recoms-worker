-- npx wrangler d1 execute dev-db-classes --local --file=./schema.sql
-- npx wrangler d1 execute dev-db-classes --local --command='SELECT * FROM Products'
DROP TABLE IF EXISTS Products;
CREATE TABLE IF NOT EXISTS Products (ProductId INTEGER PRIMARY KEY, Classification TEXT, Updated INTEGER);
INSERT INTO Products (ProductId, Classification, Updated) VALUES ('1', 'clothing', 1687240430), ('2', 'food', 1687240430);
