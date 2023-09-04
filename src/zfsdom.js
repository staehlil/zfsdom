const { spawn } = require('child_process');
const shell = require('shelljs');
const SSH2Promise = require('ssh2-promise');
const bytes = require('bytes');
const {homedir} = require("os");
const ProgressBar = require('progress');
const {statSync} = require("fs");
function execAsync(command, options = {}) {
  return new Promise((resolve) => {
    options.async = true;
    options.silent = true;
    shell.exec(command, options, (code, stdout, stderr) => {
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
    return new SSH2Promise({
      host,
      username,
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
   * @param {SSH2Promise} connection - the connection to use
   * @param {string} localDataset - the local dataset name/path
   * @param {string} remoteDataset - the remote dataset name/path
   */
  async getLatestCommonSnapshot(connection, localDataset, remoteDataset=localDataset) {
    let localList = (await this.getSnapshots(shell,localDataset)).map(item=>item.split("@")[1]);
    let remoteList = (await this.getSnapshots(connection,remoteDataset)).map(item=>item.split("@")[1]);
    let i = remoteList.length;
    while (i>=0 && !localList.find(item=>item===remoteList[i]))
      i--;
    if (i>=0)
      return remoteList[i];
    return null;
  }

  /**
   * extract the disk path from a libvirt domain xml definition
   * @param {string} targetDomain - the domain name
   * @returns {Promise<string>}
   */
  async getDiskPath(targetDomain) {
    const { stdout } = await execAsync(`virsh dumpxml "${targetDomain}" | grep "source file" | grep -o "'[^']*'" | sed "s/^'//g" | sed "s/'$//g" | head -1`);
    return stdout.trim();
  }

  /**
   * Transfer snapshot of a particular zfs dataset to the target system
   * @param {string} dataset - specify source dataset
   * @param {string} destHostPath - specify target as {hostname}:{dataset}
   * @param {boolean} run - only actually do anything if set to true, dry-run otherwise
   * @param {boolean} force - if true, rollback incremental snapshot source on destination if modified or discard existing dataset's contents if no snapshot exists on destination
   * @returns {Promise<boolean>}
   */
  async transferSnapshot(dataset, destHostPath, run, force) {
    let bar = new ProgressBar(':bar :percent', {
      total: 100,
      width: 40
    });
    const [destHost, destDataset] = destHostPath.split(':');

    const ssh = this.openRemoteSSH(destHost);
    let remoteDataset = null;
    let latestCommonSnapshot = null;
    try {
      ({dataset:remoteDataset} = await this.getDatasetByName(ssh,destDataset || dataset));
      latestCommonSnapshot = await this.getLatestCommonSnapshot(ssh,dataset,destDataset || dataset);
    } catch (err) {
      console.error("\x1b[31m%s\x1b[0m", `${(err+"").trim()}`);
    }

    if (remoteDataset)
      this.printResult(`remote zfs dataset found: ${remoteDataset}`,true)
    else {
      let parentDir = (destDataset||dataset).replace(/\/[^/]+$/,"");
      let {dataset:remoteDatasetParent} = await this.getDatasetByName(ssh,parentDir);
      if (remoteDatasetParent)
        this.printResult(`remote zfs parent dataset found: '${destDataset||dataset}' can be created`,true)
      else
        this.printResult(`remote zfs parent dataset not found: '${parentDir}' does not exist`,false)
    }
    await ssh.close();

    console.log(`latest common snapshot: ${latestCommonSnapshot ? `${latestCommonSnapshot}` : '- none found -'}`);

    await new Promise(resolve=>setTimeout(()=>resolve(),5000));

    if (run) {
      shell.exec(`zfs snapshot ${dataset}@$(date +%Y%m%d-%H%M%S)`, { silent: true });
      const localLatest = await this.getLatestSnapshot(shell,dataset);

      const cmdIncremental = latestCommonSnapshot ? `-i ${dataset}@${latestCommonSnapshot}` : "";
      const cmdForce = (force) ? '-F' : "";
      const sendCmd = 'zfs';
      const sendOpts = ['send', '-v', cmdIncremental, localLatest];
      const recvCmd = 'ssh';
      const recvOpts = [destHost, 'zfs', 'recv', destDataset || dataset, cmdForce];

      this.printShellCmd(`${sendCmd} ${sendOpts.join(" ")} | ${recvCmd} ${recvOpts.join(" ")}`);

      const send = spawn(sendCmd, sendOpts ,{shell:true});
      const recv = spawn(recvCmd, recvOpts,{shell:true});

      let totalSize = Infinity;
      let hasErrors = false;
      try {
        send.stdout.pipe(recv.stdin);
        await new Promise((resolve, reject)=>{
          send.stderr.on('data', (data) => {
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
                  const transferredBytes = bytes.parse(transferred);
                  if (transferredBytes) {
                    bar.update(transferredBytes/totalSize);
                  }
                }
              }
            }
          });
          recv.stderr.on('data', (data) => {
            console.error("\x1b[31m%s\x1b[0m", `\n${(data+"").trim()}`);
            hasErrors = true;
          });

          recv.on('close', (code) => {
            if (!hasErrors) {
              bar.update(1);
              resolve();
            }
            else if (code!==0)
              reject(`exit code ${code}`)
          });

          send.on('error', (error) => {
            console.error(`Error in send process: ${error}`);
          });
          recv.on('error', (error) => {
            console.error(`Error in recv process: ${error}`);
          });
          send.stdout.on('error', (error) => {
            reject(error);
            hasErrors = true;
          });
          recv.stdin.on('error', (error) => {
            reject(error);
            hasErrors = true;
          });
        });
      } catch (err) {
        send.stdout.destroy();
        console.error("\x1b[31m%s\x1b[0m", `${(err+"").trim()}`);
        console.log("\x1b[1m\x1b[31m%s\x1b[0m", "✖ transfer failed");
      }
      if (!hasErrors) {
        console.log("\x1b[1m\x1b[32m%s\x1b[0m", `✔ transfer successful`);
        return true;
      }
    }
    else
      return true;
    return false;
  }

  /**
   * Transfer snapshot of a particular zfs dataset - specified by the path to a file in it - to the target system
   * @param {string} path - specify source file path
   * @param {string} destHostPath - specify target as {hostname}:{dataset}
   * @param {boolean} run - only actually do anything if set to true, dry-run otherwise
   * @param {boolean} force - if true, rollback incremental snapshot source on destination if modified or discard existing dataset's contents if no snapshot exists on destination
   * @returns {Promise<boolean>}
   */
  async transferSnapshotByFilePath(path, destHostPath, run, force) {
    if (!path) return false;

    const mountPoint = path.replace(/\/[^\/]*$/g,"");
    const {dataset} = await this.getDatasetByMountPoint(shell,mountPoint)

    if (dataset) {
      this.printResult(`local zfs dataset found: ${dataset}`,true)
      return this.transferSnapshot(dataset, destHostPath, run, force)
    } else {
      this.printResult(`no zfs dataset found for '${path}'`,false)
    }
    return false;
  }

  /**
   * Transfer snapshot of a particular zfs dataset to the target system
   * @param {string} dataset - specify source file path
   * @param {string} destHostPath - specify target as {hostname}:{dataset}
   * @param {boolean} run - only actually do anything if set to true, dry-run otherwise
   * @param {boolean} force - if true, rollback incremental snapshot source on destination if modified or discard existing dataset's contents if no snapshot exists on destination
   * @returns {Promise<boolean>}
   */
  async transferSnapshotByDataset(datasetName, destHostPath, run, force) {
    const {dataset} = await this.getDatasetByName(shell,datasetName)

    if (dataset) {
      this.printResult(`local zfs dataset found: ${dataset}`,true)
      return this.transferSnapshot(dataset, destHostPath, run, force)
    } else {
      this.printResult(`no zfs dataset found for '${path}'`,false)
    }
    return false;
  }

  /**
   * Transfer snapshot of a particular zfs dataset (specified by the libvirt domain that has its disks stored on it) to the target system
   * @param {string} domain - specify domain name
   * @param {string} destHostPath - specify target as {hostname}:{dataset}
   * @param {boolean} run - only actually do anything if set to true, dry-run otherwise
   * @param {boolean} force - if true, rollback incremental snapshot source on destination if modified or discard existing dataset's contents if no snapshot exists on destination
   * @returns {Promise<boolean>}
   */
  async transferDomainSnapshot(domain, destHostPath, run, force) {
    return await this.transferSnapshotByFilePath(await this.getDiskPath(domain), destHostPath, run, force);
  }

  /**
   * Migrate libvirt domain to target hypervisor by incrementally transferring zfs snapshots and doing live (suspended) migration in-between
   * @param {string} domain - specify domain name
   * @param {string} destHostPath - specify target as {hostname}:{dataset}
   * @param {boolean} run - only actually do anything if set to true, dry-run otherwise
   * @param {boolean} force - if true, rollback incremental snapshot source on destination if modified or discard existing dataset's contents if no snapshot exists on destination
   * @returns {Promise<boolean>}
   */
  async migrateDomain(domain, destHostPath, run, force) {
    const [destHost, destPath] = destHostPath.split(':');
    let { stdout:isRunning } = await execAsync(`virsh list --name | grep -x "\\b${domain}\\b"`);
    isRunning = isRunning.trim();

    if (!isRunning) {
      console.error(`domain ${domain} is not running, aborting`);
      return false;
    }

    const path = await this.getDiskPath(domain);
    const transferSuccess = await this.transferSnapshotByFilePath(path, destHostPath, run, force);

    const {uid,gid} = statSync(path);
    const fileUser = shell.exec(`id -nu ${uid}`,{silent:true}).stdout.trim();
    const fileGroup = shell.exec(`id -ng ${gid}`,{silent:true}).stdout.trim();

    if (!transferSuccess) {
      console.error("\x1b[1m\x1b[31m%s\x1b[0m", `snapshot transfer failed, aborting`);
      return false;
    }

    if (run) {
      let customXml;
      if (destPath) {
        customXml = `/tmp/snpshmgr-${domain}.xml`;
        await execAsync(`virsh dumpxml ${domain} > ${customXml}`);
        const srcPath = path.replace(/\/[^\/]*$/, '');
        await execAsync(`sed -i "s?${srcPath}?/${destPath}?g" ${customXml}`);
      }

      await execAsync(`virsh autostart ${domain} --disable`);
      try {
        await new Promise((resolve, reject) => {
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
            `qemu+ssh://${destHost}/system`
          ];
          const virsh = spawn('virsh', args,{shell:true});
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

      await this.transferSnapshotByFilePath(path, destHostPath, run, true);

      const ssh = await this.openRemoteSSH(destHost);
      try {
        await ssh.exec(`chown ${fileUser} $(virsh dumpxml "${domain}" | grep "source file" | grep -o "'[^']*'" | sed "s/^'//g" | sed "s/'$//g" | head -1)`);
      } catch (err) {
        console.error("\x1b[31m%s\x1b[0m", `${(err+"").trim()}`);
      } finally {
        await ssh.close();
      }

      let {code:resumeDomainResult} = await execAsync(`virsh -c qemu+ssh://${destHost}/system resume ${domain}`);
      await execAsync(`virsh -c qemu+ssh://${destHost}/system autostart ${domain}`);
      this.printActionResult("domain migration",resumeDomainResult===0)
    }
  }
}

module.exports = Zfsdom;