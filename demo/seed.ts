/** Reset the demo support desk from the shell: `npm run demo:reset -- 2`. Without a batch, print the desk. */
import { table, World } from "./world.ts";

const world = new World(process.cwd());
const batch = Number(process.argv[2]);
if (batch) world.reset(batch);
console.log(table(world.read()));
