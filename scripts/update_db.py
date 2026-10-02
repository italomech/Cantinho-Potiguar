import sqlite3

conn = sqlite3.connect('dev.db')
cur = conn.cursor()

print('TABLES:', cur.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall())

statements = [
    "ALTER TABLE Product ADD COLUMN costCents INTEGER;",
    "ALTER TABLE Order ADD COLUMN feeCents INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE Order ADD COLUMN pixProofUrl TEXT;",
    "ALTER TABLE Order ADD COLUMN pixProofMime TEXT;",
    "ALTER TABLE Order ADD COLUMN pixProofStatus TEXT NOT NULL DEFAULT 'NONE';",
    "ALTER TABLE Order ADD COLUMN pixProofUploadedAt DATETIME;",
    "ALTER TABLE Order ADD COLUMN pixProofConfirmedAt DATETIME;",
    "ALTER TABLE Order ADD COLUMN pixProofConfirmedBy TEXT;",
    "CREATE TABLE IF NOT EXISTS CashMovement (id TEXT PRIMARY KEY, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, type TEXT NOT NULL, amountCents INTEGER NOT NULL, description TEXT NOT NULL, createdBy TEXT);",
    "CREATE TABLE IF NOT EXISTS CashClosure (id TEXT PRIMARY KEY, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, closedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, openingBalanceCents INTEGER NOT NULL, totalSoldCents INTEGER NOT NULL, totalReceivedCents INTEGER NOT NULL, cashCents INTEGER NOT NULL, pixCents INTEGER NOT NULL, cardCents INTEGER NOT NULL, feesCents INTEGER NOT NULL, expensesCents INTEGER NOT NULL, manualEntriesCents INTEGER NOT NULL, manualOutputsCents INTEGER NOT NULL, closingBalanceCents INTEGER NOT NULL, profitCents INTEGER NOT NULL);"
]

for statement in statements:
    try:
        cur.execute(statement)
        print('OK', statement.split(' ')[2] if statement.startswith('ALTER TABLE') else statement.split(' ')[2])
    except sqlite3.OperationalError as exc:
        if 'duplicate column name' in str(exc).lower() or 'already exists' in str(exc).lower():
            print('SKIP', exc)
        else:
            raise

conn.commit()
conn.close()
print('Database update complete.')
