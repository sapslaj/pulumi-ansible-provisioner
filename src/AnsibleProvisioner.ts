import { remote } from "@pulumi/command";
import { remote as remote_inputs } from "@pulumi/command/types/input";
import * as pulumi from "@pulumi/pulumi";
import dedent from "dedent";
import * as YAML from "yaml";

import { directoryHash, stringHash } from "./asset-utils";

export const bashBackoffRetryFunction = `
function with_backoff {
  local max_attempts=10
  local timeout=10
  local attempt=0
  local exit_code=0

  set +e
  while [ "$attempt" -lt "$max_attempts" ]; do
    "$@"
    exit_code="$?"

    if [ "$exit_code" = 0 ]; then
      set -e
      break
    fi

    echo "Failure running ($*) [$exit_code]; retrying in $timeout." 1>&2
    sleep "$timeout"
    attempt="$((attempt + 1))"
    timeout="$((timeout * 2))"
  done

  if [ "$exit_code" != 0 ]; then
    echo "Failure running ($*) [$exit_code]; No more retries left." 1>&2
  fi

  set -e
  return "$exit_code"
}
`;

/**
 * @public
 */
export interface AnsiblePlaybookRole {
  role: pulumi.Input<string>;
  vars?: pulumi.Input<Record<string, pulumi.Input<any>>>;
  [key: string]: pulumi.Input<any>;
}

/**
 * @public
 */
export interface AnsibleProvisionerProps {
  connection: remote_inputs.ConnectionArgs;
  rolePaths?: string[];
  ansibleInstallCommand?: pulumi.Input<string>;
  requirements?: pulumi.Input<any>;
  roles?: pulumi.Input<AnsiblePlaybookRole>[];
  postTasks?: pulumi.Input<pulumi.Input<any>[]>;
  preTasks?: pulumi.Input<pulumi.Input<any>[]>;
  tasks?: pulumi.Input<pulumi.Input<any>[]>;
  vars?: pulumi.Input<Record<string, pulumi.Input<any>>>;
  remotePath?: pulumi.Input<string>;
  triggers?: pulumi.Input<any[]>;
}

export interface RolesCopy {
  rolePath: string;
  asset: pulumi.asset.FileArchive;
  resource: remote.CopyToRemote;
  resourceId: string;
  hash: pulumi.Output<string>;
}

export function buildPlaybookOutput(props: AnsibleProvisionerProps): pulumi.Output<any> {
  return pulumi.all({
    roles: props.roles,
    preTasks: props.preTasks,
    postTasks: props.postTasks,
    tasks: props.tasks,
    vars: props.vars,
  }).apply(({
    roles,
    preTasks,
    postTasks,
    tasks,
    vars,
  }) => [{
    hosts: "localhost",
    connection: "local",
    become: true,
    roles: roles ?? [],
    pre_tasks: preTasks,
    post_tasks: postTasks,
    tasks: tasks,
    vars: vars,
  }]);
}

export function buildRemotePathInitCommand({ remotePath }: { remotePath: string }): string {
  return [
    `sudo mkdir -p "${remotePath}"\n`,
    `sudo chown -Rv "$USER:$USER" "${remotePath}"\n`,
  ].join("");
}

export function buildFileWriteCommand(path: string, contents: string): string {
  if (contents.includes("EOF")) {
    return `echo '${btoa(contents)}' | base64 -d | tee "${path}"\n`;
  } else {
    return [
      `cat << 'EOF' | tee "${path}"`,
      contents,
      "EOF\n",
    ].join("\n");
  }
}

export function buildRunCommand({ remotePath, id }: { remotePath: string; id: string }): string {
  return [
    "set -eu",
    bashBackoffRetryFunction,
    dedent(`
      cd "${remotePath}"
      [[ -s requirements.yml ]] && with_backoff ansible-galaxy install -r requirements.yml
      with_backoff ansible-playbook -i localhost, '${id}.yml'
    `),
  ].join("\n");
}

export function makeRolesCopies(inputs: {
  id: string;
  rolesPaths?: string[];
  connection: remote_inputs.ConnectionArgs;
  remotePath: pulumi.Input<string>;
}, opts?: pulumi.CustomResourceOptions): RolesCopy[] {
  if (!inputs.rolesPaths) {
    return [];
  }

  const rolesCopies: RolesCopy[] = [];
  for (const [index, rolePath] of inputs.rolesPaths.entries()) {
    const resourceId = `${inputs.id}-roles-copy-${index}`;
    const hash = pulumi.output(directoryHash(rolePath));
    const asset = new pulumi.asset.FileArchive(rolePath);
    const resource = new remote.CopyToRemote(resourceId, {
      remotePath: inputs.remotePath,
      connection: inputs.connection,
      source: asset,
      triggers: [
        hash,
      ],
    }, opts);
    rolesCopies.push({
      resourceId,
      resource,
      asset,
      rolePath,
      hash,
    });
  }
  return rolesCopies;
}

export function makeTriggers(inputs: {
  remotePath: pulumi.Input<string>;
  inputTriggers?: pulumi.Input<any[]>;
  requirements?: pulumi.Input<any>;
  playbook: pulumi.Output<any>;
  initCommand: remote.Command;
  rolesCopies: RolesCopy[];
}): pulumi.Output<any[]> {
  // change this to force reprovision on next up
  const serial = "serial:6e884a67-eec3-4ecc-bbc2-15f1122edf0f";

  const triggerParts: pulumi.Output<any[]>[] = [];

  if (inputs.inputTriggers) {
    triggerParts.push(pulumi.output(inputs.inputTriggers));
  }

  triggerParts.push(pulumi.output(inputs.remotePath).apply((remotePath) => [`remote-path:${remotePath}`]));

  if (inputs.requirements) {
    triggerParts.push(
      pulumi.output(inputs.requirements).apply((requirements) => [requirements]),
    );
  }

  triggerParts.push(
    pulumi.unsecret(
      pulumi.all({
        playbook: inputs.playbook,
        isSecret: pulumi.isSecret(inputs.playbook),
      }).apply(({
        playbook,
        isSecret,
      }) => {
        if (isSecret) {
          return [`playbook-secret:${stringHash(JSON.stringify(playbook))}`];
        } else {
          return [playbook];
        }
      }),
    ),
  );

  triggerParts.push(
    pulumi.unsecret(
      pulumi.all([
        inputs.initCommand.id,
        inputs.initCommand.create,
        pulumi.isSecret(inputs.initCommand.create),
      ]).apply(([
        id,
        create,
        isSecret,
      ]) => {
        if (isSecret) {
          return [
            `init-id:${id}`,
            `init-cmd-secret:${stringHash(create ?? "")}`,
          ];
        } else {
          return [
            `init-id:${id}`,
            create,
          ];
        }
      }),
    ),
  );

  inputs.rolesCopies.forEach((rc) => {
    triggerParts.push(rc.hash.apply((hash) => [`${rc.resourceId}:${hash}`]));
  });

  return pulumi.all(triggerParts).apply((parts) => {
    const triggers: any[] = [];
    triggers.push(serial);
    if (process.env.ANSIBLE_PROVISIONER_FORCE) {
      triggers.push(new Date().toUTCString());
    }
    parts.forEach((part) => {
      triggers.push(...part);
    });
    return triggers;
  });
}

/**
 * @public
 */
export class AnsibleProvisioner extends pulumi.ComponentResource {
  playbookYaml: pulumi.Output<string>;
  initCommand: remote.Command;
  rolesCopies: RolesCopy[];
  triggers: pulumi.Output<any[]>;
  runCommand: remote.Command;

  constructor(id: string, props: AnsibleProvisionerProps, opts: pulumi.ComponentResourceOptions = {}) {
    super("sapslaj:pulumi-ansible-provisioner:AnsibleProvisioner", id, {}, opts);

    const remotePath = props.remotePath ?? "/var/ansible";

    const connection = props.connection;

    const playbook = buildPlaybookOutput(props);

    const initCommands: pulumi.Input<string>[] = [
      pulumi.all({ remotePath }).apply(({ remotePath }) => buildRemotePathInitCommand({ remotePath })),
    ];
    if (props.ansibleInstallCommand) {
      initCommands.push(bashBackoffRetryFunction);
      initCommands.push(props.ansibleInstallCommand);
    }
    if (props.requirements !== undefined) {
      const requirementsYaml = pulumi.output(props.requirements).apply((requirements) => YAML.stringify(requirements));

      initCommands.push(
        pulumi.all({ requirementsYaml, remotePath }).apply(({ requirementsYaml, remotePath }) =>
          buildFileWriteCommand(`${remotePath}/requirements.yml`, requirementsYaml)
        ),
      );
    }

    const playbookYaml = playbook.apply((playbook) => YAML.stringify(playbook));
    this.playbookYaml = playbookYaml;
    initCommands.push(
      pulumi.all({ playbookYaml, remotePath }).apply(({ playbookYaml, remotePath }) =>
        buildFileWriteCommand(`${remotePath}/${id}.yml`, playbookYaml)
      ),
    );

    this.initCommand = new remote.Command(`${id}-init`, {
      create: pulumi.concat(...initCommands),
      connection,
    }, {
      parent: this,
    });

    this.rolesCopies = makeRolesCopies({
      connection,
      remotePath,
      id,
      rolesPaths: props.rolePaths,
    }, {
      parent: this,
      dependsOn: [this.initCommand],
    });

    this.triggers = makeTriggers({
      remotePath,
      initCommand: this.initCommand,
      inputTriggers: props.triggers,
      playbook,
      rolesCopies: this.rolesCopies,
      requirements: props.requirements,
    });

    this.runCommand = new remote.Command(`${id}-run`, {
      create: pulumi.all({ remotePath }).apply(({ remotePath }) => buildRunCommand({ remotePath, id })),
      connection,
      triggers: this.triggers,
    }, {
      parent: this,
      dependsOn: [
        this.initCommand,
        ...this.rolesCopies.map((rc) => rc.resource),
      ],
    });
  }
}
