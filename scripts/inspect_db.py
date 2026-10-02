import sqlite3
for path in ['dev.db', 'backups/dev.db']:
    try:
        conn = sqlite3.connect(path)
        cur = conn.cursor()
        tables = cur.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()
        print('DB:', path)
        print('TABLES:', tables)
        if tables:
            for (table_name,) in tables:
                try:
                    print(table_name, cur.execute(f"PRAGMA table_info('{table_name}')").fetchall())
                except Exception as exc:
                    print('ERR', table_name, exc)
        conn.close()
    except Exception as exc:
        print('ERR opening', path, exc)
