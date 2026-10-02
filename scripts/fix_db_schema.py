import os
import shutil
import sqlite3

TARGET = 'dev.db'
BACKUP = os.path.join('backups', 'dev.db')

if os.path.exists(TARGET):
    os.remove(TARGET)
shutil.copyfile(BACKUP, TARGET)

conn = sqlite3.connect(TARGET)
cur = conn.cursor()

add_columns = [
    ('Product', 'costCents', 'INTEGER'),
    ('Order', 'feeCents', 'INTEGER NOT NULL DEFAULT 0'),
    ('Order', 'pixProofUrl', 'TEXT'),
    ('Order', 'pixProofMime', 'TEXT'),
    ('Order', 'pixProofStatus', "TEXT NOT NULL DEFAULT 'NONE'"),
    ('Order', 'pixProofUploadedAt', 'DATETIME'),
    ('Order', 'pixProofConfirmedAt', 'DATETIME'),
    ('Order', 'pixProofConfirmedBy', 'TEXT'),
]

for table, column, column_type in add_columns:
    try:
        cur.execute(f'SELECT "{column}" FROM "{table}" LIMIT 1')
        print(f'SKIP {table}.{column} exists')
    except sqlite3.OperationalError:
        cur.execute(f'ALTER TABLE "{table}" ADD COLUMN "{column}" {column_type}')
        print(f'ADD {table}.{column}')

create_tables = [
    """
    CREATE TABLE IF NOT EXISTS CashMovement (
        id TEXT PRIMARY KEY,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        type TEXT NOT NULL,
        amountCents INTEGER NOT NULL,
        description TEXT NOT NULL,
        createdBy TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS CashClosure (
        id TEXT PRIMARY KEY,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        closedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        openingBalanceCents INTEGER NOT NULL,
        totalSoldCents INTEGER NOT NULL,
        totalReceivedCents INTEGER NOT NULL,
        cashCents INTEGER NOT NULL,
        pixCents INTEGER NOT NULL,
        cardCents INTEGER NOT NULL,
        feesCents INTEGER NOT NULL,
        expensesCents INTEGER NOT NULL,
        manualEntriesCents INTEGER NOT NULL,
        manualOutputsCents INTEGER NOT NULL,
        closingBalanceCents INTEGER NOT NULL,
        profitCents INTEGER NOT NULL
    )
    """,
]

for sql in create_tables:
    cur.execute(sql)
    print('CREATE TABLE OK')

conn.commit()
conn.close()
print('Schema repair complete.')
