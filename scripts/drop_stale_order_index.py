import sqlite3

conn = sqlite3.connect('prisma/dev.db')
cur = conn.cursor()
cur.execute('DROP INDEX IF EXISTS "Order_id_key"')
conn.commit()
conn.close()
print('Dropped stale Order_id_key index.')
