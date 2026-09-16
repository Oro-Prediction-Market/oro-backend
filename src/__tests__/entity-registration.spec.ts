/**
 * Every `@Entity()` class must be listed in AppModule's `entities` array.
 *
 * TypeORM's root DataSource here takes an explicit list rather than
 * `autoLoadEntities`, so registering a new entity with
 * `TypeOrmModule.forFeature([X])` in a feature module is NOT enough — the
 * DataSource has no metadata for it and every repository call throws
 * `EntityMetadataNotFoundError: No metadata for "X" was found` at runtime.
 *
 * Nothing catches that at compile time, and a unit test that mocks its
 * repositories will not notice either: it surfaces only when a real request
 * reaches the database. This test is the thing that notices, statically, for
 * every entity added from here on.
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const ENTITIES_DIR = join(__dirname, "..", "entities");
const APP_MODULE = join(__dirname, "..", "app.module.ts");

/**
 * Class names carrying an `@Entity()` decorator.
 *
 * Scanned line by line rather than with one regex because a class can have
 * several decorators in any order — `@Index([...])` above `@Entity()` is used
 * on UserNotification — and because some files export more than one class,
 * only some of which are entities.
 */
function entityClassNames(source: string): string[] {
  const names: string[] = [];
  let sawEntityDecorator = false;
  for (const line of source.split("\n")) {
    if (/^\s*@Entity\(/.test(line)) sawEntityDecorator = true;
    const m = /^\s*export class (\w+)/.exec(line);
    if (m) {
      if (sawEntityDecorator) names.push(m[1]);
      sawEntityDecorator = false;
    }
  }
  return names;
}

/** The identifiers inside AppModule's `entities: [ ... ]` array. */
function registeredEntities(source: string): Set<string> {
  const start = source.indexOf("entities: [");
  if (start === -1) throw new Error("Could not find the entities array in app.module.ts");
  const end = source.indexOf("]", start);
  return new Set(
    source
      .slice(start + "entities: [".length, end)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

describe("AppModule entity registration", () => {
  const registered = registeredEntities(readFileSync(APP_MODULE, "utf8"));

  const declared = readdirSync(ENTITIES_DIR)
    .filter((f) => f.endsWith(".entity.ts"))
    .flatMap((f) =>
      entityClassNames(readFileSync(join(ENTITIES_DIR, f), "utf8")).map(
        (name) => ({ name, file: f }),
      ),
    );

  it("finds the entity files at all (guards the guard)", () => {
    // If the scan silently matched nothing, every assertion below would pass
    // vacuously and this test would be worse than useless.
    expect(declared.length).toBeGreaterThan(20);
    expect(registered.size).toBeGreaterThan(20);
  });

  it.each(declared)(
    "$name is registered with the root DataSource ($file)",
    ({ name }) => {
      expect(registered.has(name)).toBe(true);
    },
  );
});
