-- npx wrangler d1 execute dev-db-classes --local --file=./schema.sql
-- npx wrangler d1 execute dev-db-classes --local --command='SELECT * FROM UserHistory'
drop table if exists Products;
create table if not exists Products (ProductId integer primary key, Classification text, Updated integer);
insert into Products (ProductId, Classification, Updated) values ('1', 'clothing', 1687240430), ('2', 'food', 1687240430);

drop table if exists UserHistory;
create table if not exists UserHistory (Cookie text, Product text, LastVisited integer, primary key (Cookie, Product));
insert into UserHistory (Cookie, Product, LastVisited) values ('example-cookie', 'Sushi', 1687311878), ('example-cookie', 'T-shirt', 1687311913);
