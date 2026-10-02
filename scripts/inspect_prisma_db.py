import sqlite3

for path in ['prisma/dev.db', 'prisma/dev-backup-20260924.db']:
    print('DB:', path)
    try:
        conn = sqlite3.connect(path)
        cur = conn.cursor()
        tables = cur.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()
        print('TABLES:', tables)
        for table in [row[0] for row in tables]:
            print('---', table)
            print(cur.execute(f"PRAGMA table_info('{table}')").fetchall())
        conn.close()
    except Exception as exc:
        print('ERROR:', exc)
