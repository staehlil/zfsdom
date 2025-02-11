const { spawn } = require('child_process');
const shell = require('shelljs');
const SSH2Promise = require('ssh2-promise');
const bytes = require('bytes');
const {homedir} = require("os");
const ProgressBar = require('progress');
const {statSync} = require("fs");
function execAsync(command, options = {},_shell=shell) {
  return new Promise((resolve) => {
    options.async = true;
    options.silent = true;
    _shell.exec(command, options, (code, stdout, stderr) => {
      resolve({code,stdout,stderr});
    });
  });
}

class Zfsdom {
  /**
   * print generic status information to the console
   * @param {string} result
   * @param {boolean} success
   */
  printResult(result, success) {
    if (success)
      console.log("\x1b[1m\x1b[32m%s\x1b[0m", `✔ ${result}`);
    else
      console.error("\x1b[1m\x1b[31m%s\x1b[0m", `✖ ${result}`);
  }

  /**
   * print action status information to the console
   * @param {string} actionName
   * @param {boolean} success
   */
  printActionResult(actionName, success) {
    return this.printResult(`${actionName} ${success ? 'successful' : 'failed'}`,success)
  }

  /**
   * print shell cmd
   * @param {string} cmd
   * @param {boolean} success
   */
  printShellCmd(cmd) {
    console.log("\x1b[34m%s\x1b[0m", cmd);
  }

  /**
   * Connect to remote host using ssh
   * @param {string} remoteHost - The remote host. Include the port if it's not 22, e.g. remotehost:2222.
   * @param {string} username - The username to use for the connection, defaults to root
   * @param {string} identity - The path to the local user's private key, defaults to ~/.ssh/id_rsa
   * @returns {SSH2Promise}
   */
  openRemoteSSH(remoteHost,username="root",identity=`/${homedir()}/.ssh/id_rsa`) {
    let [host,port] = remoteHost.split(":");
    let [,_username,_host] = host.match(/([^@]+)@([^@]+)$/)||[];

    return new SSH2Promise({
      host:_host||host,
      username:_username||username,
      port: port || 22,
      identity
    })
  }

  /**
   * Get/validate a zfs dataset by pattern on a remote or local system
   * @param {SSH2Promise|shell} terminal - the connection (SSH2Promise) or shell to use for the zfs command
   * @param {string} pattern - the pattern
   * @returns {Promise<{size: string, dataset: *}>}
   */
  async getDatasetByPattern(terminal,pattern) {
    let size, dataset, path;
    const list = (await terminal.exec(`zfs list | grep '${pattern}'`, { silent: true })).split(/\n/).filter(s=>s);
    if (list.length)
      [dataset,,,,path] = list[list.length-1].split(/\s+/);
    return {dataset}
  }

  /**
   * Get/validate a zfs dataset by mount point on a remote or local system
   * @param {SSH2Promise|shell} terminal - the connection (SSH2Promise) or shell to use for the zfs command
   * @param {string} path - the pattern
   * @returns {Promise<{size: string, dataset: *}>}
   */
  async getDatasetByMountPoint(terminal, path){
    return await this.getDatasetByPattern(terminal,`\\s${path}$`);
  }

  /**
   * Get/validate a zfs dataset by its name on a remote or local system
   * @param {SSH2Promise|shell} terminal - the connection (SSH2Promise) or shell to use for the zfs command
   * @param {string} datasetName - the pattern
   * @returns {Promise<{size: string, dataset: *}>}
   */
  async getDatasetByName(terminal, datasetName){
    return await this.getDatasetByPattern(terminal,`\\b${datasetName}$`);
  }

  /**
   * Get a list of all snapshots of a particular zfs dataset on a remote or local system
   * @param {SSH2Promise|shell} terminal - the connection (SSH2Promise) or shell to use for the zfs command
   * @param {string} datasetName - the dataset name
   */
  async getSnapshots(terminal, datasetName) {
    return (await terminal.exec(`(zfs list -r ${datasetName} -t snapshot | awk '{print $1}')`,{ silent: true })).split(/\n/).filter(s=>s.match("@"))
  }

  /**
   * Get the latest snapshot of a particular zfs dataset on a remote or local system
   * @param {SSH2Promise|shell} terminal - the connection (SSH2Promise) or shell to use for the zfs command
   * @param {string} dataset
   */
  async getLatestSnapshot(terminal, dataset) {
    let list = await this.getSnapshots(terminal, dataset);
    return list.length>0 ? list[list.length-1] : null;
  }

  /**
   * Get the latest snapshot on the remote system that exists on the local system as well
   * @param {SSH2Promise} destShell - the connection to use for the dest dataset
   * @param {string} srcHostDataset - the local dataset name/path
   * @param {string} destDataset - the remote dataset name/path
   */
  async getLatestCommonSnapshot(destShell, srcHostDataset, destDataset) {
    const {host:srcHost, port:srcPort, attr:srcDataset} = this.splitHostPortAttr(srcHostDataset);
    const srcHostPort = srcHost ? `${srcHost}${srcPort ? `:${srcPort}` : ""}` : null;
    const srcShell = srcHost ? await this.openRemoteSSH(srcHostPort) : shell;
    if (!destDataset)
      destDataset = srcDataset;

    let srcList = (await this.getSnapshots(srcShell,srcDataset)).map(item=>item.split("@")[1]);
    if (srcHost)
      await srcShell.close();
    let destList = (await this.getSnapshots(destShell,destDataset)).map(item=>item.split("@")[1]);
    let i = destList.length;
    while (i>=0 && !srcList.find(item=>item===destList[i]))
      i--;
    if (i>=0)
      return destList[i];
    return null;
  }

  /**
   * extract the disk path from a libvirt domain xml definition
   * @param {string} targetHostDomain - the domain name with optional HOST[:PORT] prefix
   * @returns {Promise<string>}
   */
  async getDiskPath(targetHostDomain) {
    const {host, port, attr:domain} = this.splitHostPortAttr(targetHostDomain);
    const { stdout } = await execAsync(`${host ? `ssh ${host}${port ? ` -p ${port}` : ""} ` : ""}virsh dumpxml "${domain}" | grep "source file" | grep -o "'[^']*'" | sed "s/^'//g" | sed "s/'$//g" | head -1`);
    return stdout.trim();
  }

  /**
   * extract the disk path from a libvirt domain xml definition
   * @param {string} targetHostPort - the target host specified as HOST[:PORT]
   * @returns {Promise<string>}
   */
  async getDomains(targetHostPort, showAll=false) {
    const [host,port] = (targetHostPort||"").split(":");
    const { stdout } = await execAsync(`${host ? `ssh ${host}${port ? ` -p ${port}` : ""} ` : ""}virsh list ${showAll ? " --all" : ""} | tail -n+3`);
    return stdout.split(/\n/g).filter(i=>i).map(i=>{
      let [id,name,state] = i.trim().split(/\s+/g).map(i=>i.trim());
      return {id,name,state};
    });
  }

  /**
   * split colon-separated arguments containing an attribute with optional HOST[:PORT] prefix
   * @param hostPortAttr
   * @returns {{port: string, host: string, attr: string}}
   */
  splitHostPortAttr(hostPortAttr) {
    let host = null;
    let port = null;
    let attr = hostPortAttr;
    let parts = hostPortAttr.split(":");
    if (parts.length>1) {
      host = parts.shift();
      let part = parts.shift();
      if (isNaN(part))
        attr = part;
      else
        port = part;
    }
    if (parts.length)
      attr = parts.shift();
    return {
      host, port, attr
    }
  }

  /**
   * Transfer snapshot of a particular zfs dataset to the target system
   * @param {string} srcHostDataset - specify source dataset, optionally prefixed by HOST[:PORT]
   * @param {string} destHostPath - specify target as {hostname}:{dataset}
   * @param {boolean} run - only actually do anything if set to true, dry-run otherwise
   * @param {boolean} force - if true, rollback incremental snapshot source on destination if modified or discard existing dataset's contents if no snapshot exists on destination
   * @returns {Promise<boolean>}
   */
  async transferSnapshot(srcHostDataset, destHostPath, run, force) {
    let bar = new ProgressBar(':bar :percent', {
      total: 100,
      width: 40
    });

    let {host:srcHost, port:srcPort, attr:dataset} = this.splitHostPortAttr(srcHostDataset);

      let destParts = destHostPath.split(":");
      let destHost = destParts.shift();
      let destHostInternal = null
      let destDataset = null;
      if (destParts.length) {
          let part = destParts.shift();
          let regexInternalHostname = /\[([^)]+)\]$/;
          ([,destHostInternal] = part.match(regexInternalHostname)||[]);
          if (destHostInternal)
              part = part.replace(regexInternalHostname,"");
          if (isNaN(part))
              destDataset = part;
          else
              destHost = `${destHost}:${part}`
      }
      if (destParts.length)
          destDataset = destParts.shift();

    const ssh = await this.openRemoteSSH(destHost);
    let remoteDataset = null;
    let latestCommonSnapshot = null;
    try {
      ({dataset:remoteDataset} = await this.getDatasetByName(ssh,destDataset || dataset));
      latestCommonSnapshot = await this.getLatestCommonSnapshot(ssh,srcHostDataset,destDataset || dataset);
    } catch (err) {
      console.error("\x1b[31m%s\x1b[0m", `${(err+"").trim()}`);
    }

    if (remoteDataset)
      this.printResult(`zfs dataset on ${destHost} found: ${remoteDataset}`,true)
    else {
      let parentDir = (destDataset||dataset).replace(/\/[^/]+$/,"");
      let {dataset:remoteDatasetParent} = await this.getDatasetByName(ssh,parentDir);
      if (remoteDatasetParent)
        this.printResult(`zfs parent dataset on ${destHost} found: '${destDataset||dataset}' can be created`,true)
      else
        this.printResult(`zfs parent dataset on ${destHost} not found: '${parentDir}' does not exist`,false)
    }
    await ssh.close();

    console.log(`latest common snapshot: ${latestCommonSnapshot ? `${latestCommonSnapshot}` : '- none found -'}`);

    await new Promise(resolve=>setTimeout(()=>resolve(),1000));

    if (run) {
      let srcHostPort = `${srcHost}${srcPort ? `:${srcPort}` : ""}`
      let terminal = srcHost ? await this.openRemoteSSH(srcHostPort) : shell;
      await terminal.exec(`zfs snapshot ${dataset}@$(date +%Y%m%d-%H%M%S)`, { silent: true });
      const localLatest = await this.getLatestSnapshot(terminal,dataset);
      if (srcHost)
        await terminal.close();

      const cmdIncremental = latestCommonSnapshot ? `-i ${dataset}@${latestCommonSnapshot}` : "";
      const cmdForce = (force) ? '-F' : "";
      const sendCmd = `zfs`;
      const sendOpts = ['send', '-v', cmdIncremental, localLatest];
      const recvCmd = 'ssh';
      const [destHostName, destPort] = (destHostInternal||destHost).split(":");
      const recvOpts = [...destPort ? ['-p', destPort] : [], destHostName, 'zfs', 'recv', destDataset || dataset, cmdForce];

      this.printShellCmd(`${sendCmd} ${sendOpts.join(" ")} | ${recvCmd} ${recvOpts.join(" ")}`);

      const ssh = srcHost ? await this.openRemoteSSH(srcHostPort) : null;

      const sendRecv = await (ssh ? ssh.spawn : spawn).call(this,`${sendCmd} ${sendOpts.join(" ")} | ${recvCmd} ${recvOpts.join(" ")}`,[],{shell:true})

      let totalSize = Infinity;
      let transferredBytes = 0;
      let hasErrors = false;
      try {
        //send.stdout.pipe(recv.stdin);
        await new Promise((resolve, reject)=>{
          let errors = [];
          sendRecv.stderr.on('data', (data) => {
            const totalMatch = `${data}`.match(/total estimated size is (\d+(\.\d+)?[KMGT]?i?B?)/);
            if (totalMatch) {
              let totalSizeHuman = totalMatch[1];
              if (!totalSizeHuman.match(/B$/i))
                totalSizeHuman+="B";
              totalSize = bytes.parse(totalSizeHuman);
              console.log(`transferring ${totalSizeHuman}`)
            }
            else {
              const out = data.toString().trim();
              const lines = out.split('\n');
              for(const line of lines) {
                let [,transferred] = line.split(/\s+/);
                if (transferred) {
                  if (!transferred.match(/B$/i))
                    transferred+="B";
                  transferredBytes = bytes.parse(transferred);
                }
                if (transferredBytes)
                  bar.update(transferredBytes/totalSize);
                else
                  errors.push(line)
              }
            }
          });
          sendRecv.on('close', (code) => {
            if (code === 0) {
              bar.update(1);

              resolve();
            } else {
              reject(errors);
            }
          });
          /* listener needs to be attached on stdout, otherwise the process keeps hanging */
          sendRecv.stdout.on('data', (data) => {});
        });
      } catch (errors) {
        sendRecv.stdout.destroy();
        hasErrors = true;
        console.error("\x1b[31m%s\x1b[0m", `${errors.filter(e=>!e.match(/^TIME\s+SENT\s+SNAPSHOT/)).join("\n")}`);
      }
      if (ssh)
        ssh.close();
      if (!hasErrors) {
        console.log("\x1b[1m\x1b[32m%s\x1b[0m", `✔ transfer successful`);
        return true;
      }
      else
        console.log("\x1b[1m\x1b[31m%s\x1b[0m", "✖ transfer failed");
    }
    else
      return true;
    return false;
  }

  /**
   * Transfer snapshot of a particular zfs dataset - specified by the path to a file in it - to the target system
   * @param {string} srcHostPath - specify source file path, optionally prefixed by HOST[:PORT]
   * @param {string} destHostPath - specify target as {hostname}:{dataset}
   * @param {boolean} run - only actually do anything if set to true, dry-run otherwise
   * @param {boolean} force - if true, rollback incremental snapshot source on destination if modified or discard existing dataset's contents if no snapshot exists on destination
   * @returns {Promise<boolean>}
   */
  async transferSnapshotByFilePath(srcHostPath, destHostPath, run, force) {
    if (!srcHostPath) return false;

    const {host:srcHost, port:srcPort, attr:path} = this.splitHostPortAttr(srcHostPath);
    const srcHostPort = srcHost ? `${srcHost}${srcPort ? `:${srcPort}` : ""}` : null;
    const terminal = srcHost ? await this.openRemoteSSH(srcHostPort) : shell;
    const mountPoint = path.replace(/\/[^\/]*$/g,"");
    const {dataset} = await this.getDatasetByMountPoint(terminal,mountPoint);
    if (srcHost)
      await terminal.close();

    if (dataset) {
      const srcHostDataset = `${srcHostPort ? `${srcHostPort}:` : ""}${dataset}`;
      this.printResult(`${!srcHostPort ? "local " : ""}zfs dataset ${srcHostPort ? `on ${srcHostPort} ` : ""}found: ${dataset}`,true)
      return this.transferSnapshot(srcHostDataset, destHostPath, run, force)
    } else {
      this.printResult(`no zfs dataset found for '${path}'`,false)
    }
    return false;
  }

  /**
   * Transfer snapshot of a particular zfs dataset to the target system
   * @param {string} srcHostDatasetName - specify source file path
   * @param {string} destHostPath - specify target as {hostname}:{dataset}
   * @param {boolean} run - only actually do anything if set to true, dry-run otherwise
   * @param {boolean} force - if true, rollback incremental snapshot source on destination if modified or discard existing dataset's contents if no snapshot exists on destination
   * @returns {Promise<boolean>}
   */
  async transferSnapshotByDataset(srcHostDatasetName, destHostPath, run, force) {
    const {host:srcHost, port:srcPort, attr:datasetName} = this.splitHostPortAttr(srcHostDatasetName);
    const srcHostPort = srcHost ? `${srcHost}${srcPort ? `:${srcPort}` : ""}` : null;
    const terminal = srcHost ? await this.openRemoteSSH(srcHostPort) : shell;
    const {dataset} = await this.getDatasetByName(terminal,datasetName);
    if (srcHost)
      terminal.close();

    if (dataset) {
      this.printResult(`${!srcHostPort ? "local " : ""}zfs dataset ${srcHostPort ? `on ${srcHostPort} ` : ""}found: ${dataset}`,true)
      return this.transferSnapshot(`${srcHostPort ? `${srcHostPort}:` : ""}${dataset}`, destHostPath, run, force)
    } else {
      this.printResult(`no zfs dataset found for '${srcHostDatasetName}'`,false)
    }
    return false;
  }

  /**
   * Transfer snapshot of a particular zfs dataset (specified by the libvirt domain that has its disks stored on it) to the target system
   * @param {string} srcHostDomain - specify domain name
   * @param {string} destHostPath - specify target as {hostname}:{port}({internal_hostname}):{dataset}
   * @param {boolean} run - only actually do anything if set to true, dry-run otherwise
   * @param {boolean} force - if true, rollback incremental snapshot source on destination if modified or discard existing dataset's contents if no snapshot exists on destination
   * @returns {Promise<boolean>}
   */
  async transferDomainSnapshot(srcHostDomain, destHostPath, run, force) {
    const {host:srcHost, port:srcPort, attr:domain} = this.splitHostPortAttr(srcHostDomain);
    const srcHostPort = srcHost ? `${srcHost}${srcPort ? `:${srcPort}` : ""}` : null;
    let path = await this.getDiskPath(srcHostDomain);
    if (!path) {
      this.printResult(`no disk path found for '${srcHostDomain}' (does the domain ${domain} exist on ${srcHostPort}?)`,false)
      return false;
    }
    return await this.transferSnapshotByFilePath(`${srcHostPort ? `${srcHostPort}:` : ""}${path}`, destHostPath, run, force);
  }

  /**
   * Migrate libvirt domain to target hypervisor by incrementally transferring zfs snapshots and doing live (suspended) migration in-between
   * @param {string} domain - specify domain name
   * @param {string} destHostPath - specify target as {hostname}:{port}({internal_hostname}):{dataset}
   * @param {boolean} run - only actually do anything if set to true, dry-run otherwise
   * @param {boolean} force - if true, rollback incremental snapshot source on destination if modified or discard existing dataset's contents if no snapshot exists on destination
   * @returns {Promise<boolean>}
   */
  async migrateDomain(srcHostDomain, destHostPath, run, force) {
    let destParts = destHostPath.split(":");
    let destHost = destParts.shift();
    let destHostInternal = null
    let destPath = null;
    if (destParts.length) {
      let part = destParts.shift();
      let regexInternalHostname = /\[([^)]+)\]$/;
      ([,destHostInternal] = part.match(regexInternalHostname)||[]);
      if (destHostInternal)
        part = part.replace(regexInternalHostname,"");
      if (isNaN(part))
        destPath = part;
      else
        destHost = `${destHost}:${part}`
    }
    if (destParts.length)
      destPath = destParts.shift();

    const destHostPathInternal = destHostInternal ? `${destHostInternal||destHost}${destPath ? `:${destPath}` : ""}` : null;

    const {host:srcHost, port:srcPort, attr:domain} = this.splitHostPortAttr(srcHostDomain);
    const srcHostPort = srcHost ? `${srcHost}${srcPort ? `:${srcPort}` : ""}` : null;

    let { stdout:isRunning } = await execAsync(`${srcHost ? `ssh ${srcHost}${srcPort ? ` -p ${srcPort}` : ""} ` : ""}virsh list --name | grep -x "\\b${domain}\\b"`);
    isRunning = isRunning.trim();

    if (!isRunning) {
      console.error(`domain ${domain} is not running, aborting`);
      return false;
    }

    const path = await this.getDiskPath(srcHostDomain);
    const transferSuccess = await this.transferSnapshotByFilePath(`${srcHostPort ? `${srcHostPort}:` : ""}${path}`, destHostPath, run, force);

    const terminal = srcHost ? await this.openRemoteSSH(srcHostPort) : shell;
    const [uid,gid] = (await terminal.exec(`stat -c '%u %g' ${path}`)).split(/\s+/);
    const fileUser = (await terminal.exec(`id -nu ${uid}`,{silent:true})).trim();
    const fileGroup = (await terminal.exec(`id -ng ${gid}`,{silent:true})).trim();

    if (!transferSuccess) {
      console.error("\x1b[1m\x1b[31m%s\x1b[0m", `snapshot transfer failed, aborting`);
      if (srcHost)
        terminal.close();
      return false;
    }

    if (run) {
      let customXml;
      if (destPath) {
        customXml = `/tmp/snpshmgr-${domain}.xml`;
        await terminal.exec(`virsh dumpxml ${domain} > ${customXml}`);
        const srcPath = path.replace(/\/[^\/]*$/, '');
        await terminal.exec(`sed -i "s?${srcPath}?/${destPath}?g" ${customXml}`);
      }
      await terminal.exec(`virsh autostart ${domain} --disable`);
      try {
        await new Promise(async (resolve, reject) => {
          const args = [
            'migrate',
            '--live',
            '--suspend',
            '--persistent',
            '--verbose',
            '--unsafe',
            ...(
                destPath ? [
                  '--persistent-xml',
                  customXml,
                  '--xml',
                  customXml
                ] : []
            ),
            domain,
            `qemu+ssh://${destHostInternal||destHost}/system`
          ];
          const virsh = await (srcHost ? terminal.spawn : spawn).call(this,'virsh', args, {shell:true});
          virsh.stdout.on('data', (data) => {
            process.stdout.write(data);
          });
          virsh.stderr.on('data', (data) => {
            process.stderr.write(data);
          });
          virsh.on('error', (error) => {
            reject(error);
          });
          virsh.on('exit', (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`virsh process exited with code ${code}`));
            }
          });
        });
      } catch (error) {
        console.error('An error occurred:', error);
      }

      await this.transferSnapshotByFilePath(`${srcHostPort ? `${srcHostPort}:` : ""}${path}`, destHostPath, run, true);

      const ssh = await this.openRemoteSSH(destHost);
      try {
        await ssh.exec(`chown ${fileUser} $(virsh dumpxml "${domain}" | grep "source file" | grep -o "'[^']*'" | sed "s/^'//g" | sed "s/'$//g" | head -1)`);
      } catch (err) {
        console.error("\x1b[31m%s\x1b[0m", `${(err+"").trim()}`);
      } finally {
        await ssh.close();
      }

      let {code:resumeDomainResult} = await execAsync(`${srcHost ? `ssh ${srcHost}${srcPort ? ` -p ${srcPort}` : ""} ` : ""}virsh -c qemu+ssh://${destHostInternal||destHost}/system resume ${domain}`);
      await execAsync(`${srcHost ? `ssh ${srcHost}${srcPort ? ` -p ${srcPort}` : ""} ` : ""}virsh -c qemu+ssh://${destHostInternal||destHost}/system autostart ${domain}`);
      this.printActionResult("domain migration",resumeDomainResult===0)

    }
    if (srcHost)
      terminal.close();
  }
  /**
   * Execute virsh operation upon libvirt domain
   * @param {string} srcHostDomain - specify domain name
   * @param {string} cmd - command to execute
   * @returns {Promise<boolean>}
   */
  async executeDomainOperation(srcHostDomain, cmd) {
    const {host, port, attr:domain} = this.splitHostPortAttr(srcHostDomain);
    const hostPort = host ? `${host}${port ? `:${port}` : ""}` : null;
    const terminal = host ? await this.openRemoteSSH(hostPort) : shell;
    try {
      await new Promise(async (resolve, reject) => {
        const virsh = await (host ? terminal.spawn : spawn).call(this,'virsh', [cmd,`"${domain}"`], {shell:true});
        virsh.stdout.on('data', (data) => {
          process.stdout.write(data);
        });
        virsh.stderr.on('data', (data) => {
          process.stderr.write(data);
        });
        virsh.on('error', (error) => {
          reject(error);
        });
        virsh.on('exit', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error());
          }
        });
      });
      this.printResult("domain operation completed successfully",true)
    } catch (error) {
      this.printResult("domain operation failed",false)
    }
    if (host)
      terminal.close();
  }
}

module.exports = Zfsdom;