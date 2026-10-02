import sqlite3
conn = sqlite3.connect('prisma/dev.db')
cur = conn.cursor()
for table in ['Admin','Order','OrderItem','Product','Setting','CashMovement','CashClosure']:
    print('TABLE', table)
    try:
        indexes = cur.execute(f"PRAGMA index_list('{table}')").fetchall()
        for idx in indexes:
            print('  INDEX', idx)
            print('  SQL', cur.execute(f"SELECT sql FROM sqlite_master WHERE type='index' AND name=?", (idx[1],)).fetchone())
    except Exception as exc:
        print('ERROR', exc)
conn.close()
