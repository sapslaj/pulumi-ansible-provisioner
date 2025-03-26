import t from "tap";

import { concatCommands } from "./asset-utils";

t.test("concatCommands", (t) => {
  const cmd = concatCommands([
    "echo a\n",
    "",
    "\n",
    undefined,
    "echo b\necho c",
    "echo d",
  ]);

  cmd.apply((cmd) => {
    t.equal(
      cmd,
      `echo a


echo b
echo c
echo d
`,
    );
    t.end();
  });
});
