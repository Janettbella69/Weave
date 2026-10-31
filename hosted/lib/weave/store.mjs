// All changed documents commit atomically. The global revision prevents lost
// confirmations/double bookings across independent Worker isolates.
export class Store {
  constructor(db,{strict=false}={}) { this.db = db; this.strict=strict; }
  async load() {
    await this.db.prepare("INSERT OR IGNORE INTO weave_commits (id, revision, token) VALUES ('world', 0, '')").run();
    const [lock, docs] = await this.db.batch([
      this.db.prepare("SELECT revision FROM weave_commits WHERE id='world'"),
      this.db.prepare("SELECT id, kind, document FROM weave_documents"),
    ]);
    const world = { people: {}, negotiations: {}, invites: {}, links: {} };
    this.original = new Map();
    for (const row of docs.results) {
      world[row.kind][row.id] = JSON.parse(row.document);
      this.original.set(row.id, row.document);
    }
    this.revision = lock.results[0].revision;
    return world;
  }
  async save(world, attempt=0) {
    const changes = [], next = new Map();
    for (const kind of ['people', 'negotiations', 'invites', 'links']) {
      for (const [id, value] of Object.entries(world[kind])) {
        const document = JSON.stringify(value); next.set(id, document);
        if (this.original.get(id) !== document) changes.push({ id, kind, document });
      }
    }
    const removed = [...this.original.keys()].filter(id => !next.has(id));
    if (!changes.length && !removed.length) return;
    const token = crypto.randomUUID();
    const statements = [this.db.prepare("UPDATE weave_commits SET revision=revision+1, token=? WHERE id='world' AND revision=?").bind(token, this.revision)];
    for (const row of changes) statements.push(this.db.prepare("INSERT INTO weave_documents (id,kind,document) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM weave_commits WHERE id='world' AND token=?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, document=excluded.document").bind(row.id,row.kind,row.document,token));
    for (const id of removed) statements.push(this.db.prepare("DELETE FROM weave_documents WHERE id=? AND EXISTS (SELECT 1 FROM weave_commits WHERE id='world' AND token=?)").bind(id,token));
    const result = await this.db.batch(statements);
    if (result[0].meta.changes !== 1) {
      const latest = new Store(this.db), fresh = await latest.load();
      const touched = new Set([...changes.map(x=>x.id),...removed]);
      if(!this.strict && attempt<3 && [...touched].every(id=>latest.original.get(id)===this.original.get(id))){
        // An unrelated account changed: merge only untouched documents. Changes
        // to either participant or the proposal itself require explicit retry.
        for(const kind of ['people','negotiations','invites','links']){
          for(const id of Object.keys(world[kind]))if(!touched.has(id)&&!fresh[kind][id])delete world[kind][id];
          for(const [id,value] of Object.entries(fresh[kind]))if(!touched.has(id))world[kind][id]=value;
        }
        this.original=latest.original;this.revision=latest.revision;
        return this.save(world,attempt+1);
      }
      const error = new Error('安排刚刚发生变化，请刷新后重试'); error.status = 409; throw error;
    }
    this.revision++; this.original = next;
  }
}
