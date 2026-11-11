# M9 file connector check

The connector reads CSV, Excel, and SQLite revenue files only inside a granted folder. The same sample rows and the same total come from all three. A file outside the granted folder is denied and shows on Activity. Those checks run in CI. On a device, point the connector at a folder you granted and confirm a file outside it does not open.
