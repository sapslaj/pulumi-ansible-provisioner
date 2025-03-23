import t from "tap";
import {
    bashBackoffRetryFunction,
  buildFileWriteCommand,
  buildRemotePathInitCommand,
  buildRunCommand,
  makePlaybookOutput,
} from "./AnsibleProvisioner";

t.test("buildRemotePathInitCommand", async (t) => {
  const cmd = buildRemotePathInitCommand({ remotePath: "/root" });
  t.equal(cmd, `sudo mkdir -p "/root"\nsudo chown -Rv "$USER:$USER" "/root"\n`);
});

t.test("buildFileWriteCommand", async (t) => {
  t.test("no EOF", async (t) => {
    const cmd = buildFileWriteCommand("/foo.yaml", "---\na: foo\nb: bar\n");
    t.equal(cmd, `cat << 'EOF' | tee "/foo.yaml"\n---\na: foo\nb: bar\n\nEOF\n`);
  });

  t.test("with EOF", async (t) => {
    const cmd = buildFileWriteCommand("/bin/hello", "cat << 'EOF'\nhello world!\nEOF");
    t.equal(cmd, `echo 'Y2F0IDw8ICdFT0YnCmhlbGxvIHdvcmxkIQpFT0Y=' | base64 -d | tee "/bin/hello"\n`);
  });
});

t.test("buildRunCommand", async (t) => {
  t.test("minimal", async (t) => {
    const cmd = buildRunCommand({
      remotePath: "/root",
      id: "main",
    });

    t.equal(cmd, `set -eu
${bashBackoffRetryFunction}
cd "/root"
[[ -s requirements.yml ]] && with_backoff ansible-galaxy install -r requirements.yml
with_backoff ansible-playbook -i localhost, 'main.yml'
`);
  });

  t.test("withBackoff true", async (t) => {
    const cmd = buildRunCommand({
      remotePath: "/root",
      id: "main",
      withBackoff: true,
    });

    t.equal(cmd, `set -eu
${bashBackoffRetryFunction}
cd "/root"
[[ -s requirements.yml ]] && with_backoff ansible-galaxy install -r requirements.yml
with_backoff ansible-playbook -i localhost, 'main.yml'
`);
  });

  t.test("withBackoff false", async (t) => {
    const cmd = buildRunCommand({
      remotePath: "/root",
      id: "main",
      withBackoff: false,
    });

    t.equal(cmd, `set -eu

cd "/root"
[[ -s requirements.yml ]] && ansible-galaxy install -r requirements.yml
ansible-playbook -i localhost, 'main.yml'
`);
  });

  t.test("withBackoff true and withBackoffDefinition", async (t) => {
    const cmd = buildRunCommand({
      remotePath: "/root",
      id: "main",
      withBackoff: true,
      withBackoffDefinition: "function with_backoff {\n  \"$@\"\n}",
    });

    t.equal(cmd, `set -eu
function with_backoff {
  "$@"
}
cd "/root"
[[ -s requirements.yml ]] && with_backoff ansible-galaxy install -r requirements.yml
with_backoff ansible-playbook -i localhost, 'main.yml'
`);
  });

  t.test("withBackoff false and withBackoffDefinition", async (t) => {
    const cmd = buildRunCommand({
      remotePath: "/root",
      id: "main",
      withBackoff: false,
      withBackoffDefinition: "function with_backoff {\n  \"$@\"\n}",
    });

    t.equal(cmd, `set -eu
function with_backoff {
  "$@"
}
cd "/root"
[[ -s requirements.yml ]] && ansible-galaxy install -r requirements.yml
ansible-playbook -i localhost, 'main.yml'
`);
  });
});

t.test("makePlaybookOutput", async (t) => {
  t.test("only roles", (t) => {
    makePlaybookOutput({
      roles: [
        {
          role: "foo",
        },
        {
          role: "bar",
          vars: {
            bar_foo: "baz",
          },
        },
      ],
    }).apply((playbook) => {
      t.match(playbook, [
        {
          hosts: "localhost",
          connection: "local",
          become: true,
          roles: [
            {
              role: "foo",
            },
            {
              role: "bar",
              vars: {
                bar_foo: "baz",
              },
            },
          ],
        },
      ]);
      t.end();
    });
  });

  t.test("full", (t) => {
    makePlaybookOutput({
      roles: [
        {
          role: "foo",
        },
      ],
      preTasks: [
        {
          name: "pre task",
          pre_task: {
            foo: "bar",
          },
        },
      ],
      postTasks: [
        {
          name: "post task",
          post_task: {
            foo: "bar",
          },
        },
      ],
      tasks: [
        {
          name: "task",
          task: {
            foo: "bar",
          },
        },
      ],
    }).apply((playbook) => {
      t.match(playbook, [
        {
          hosts: "localhost",
          connection: "local",
          become: true,
          roles: [
            {
              role: "foo",
            },
          ],
          pre_tasks: [
            {
              name: "pre task",
              pre_task: {
                foo: "bar",
              },
            },
          ],
          post_tasks: [
            {
              name: "post task",
              post_task: {
                foo: "bar",
              },
            },
          ],
          tasks: [
            {
              name: "task",
              task: {
                foo: "bar",
              },
            },
          ],
        },
      ]);
      t.end();
    });
  });
});
