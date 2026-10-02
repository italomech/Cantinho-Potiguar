import sqlite3

conn = sqlite3.connect('prisma/dev.db')
cur = conn.cursor()

try:
    cur.execute('DROP TABLE IF EXISTS _prisma_migrations')
    conn.commit()
    print('Dropped _prisma_migrations')
except Exception as exc:
    print('ERROR:', exc)
finally:
    conn.close()
