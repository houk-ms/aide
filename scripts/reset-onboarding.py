import sqlite3, json, datetime, os

p = os.path.join(os.environ['APPDATA'], 'aide', 'data', 'aide.db')
c = sqlite3.connect(p, timeout=10)
r = c.execute('SELECT content FROM memory_entries WHERE id=?', ('__user_preferences',)).fetchone()
d = json.loads(r[0]) if r and r[0] else {}
d['onboardingComplete'] = False
now = datetime.datetime.utcnow().isoformat()
c.execute(
    "INSERT OR REPLACE INTO memory_entries (id,layer,content,source,status,created_at,updated_at,tags) "
    "VALUES (?,'L0',?,'system','active',?,?,'[]')",
    ('__user_preferences', json.dumps(d), now, now),
)
c.commit()
c.close()
print('reset ->', json.dumps(d))
