# zfsdom

## What is this?

`zfsdom` uses ZFS to perform libvirt live migration between two Linux hypervisors without the need for shared storage. Depending on your use case, expect minimal to no downtime during the migration.

## Why would one use this?

If you're running Linux KVM with libvirt and are looking for a quick and efficient way to move your running VMs between hypervisors without the complexity of shared storage, `zfsdom` is worth a try.

`zfsdom` leverages ZFS snapshots and the `zfs send/recv` mechanism to incrementally stream your VM block device data between hypervisors. If your VM storage is already on individual ZFS datasets, you're all set to go.
You can also just use the zfs transfer feature to create consistent remote copies of your VMs without migrating them at all. In fact, if you just want a convenient way to synchronize zfs datasets (regardless of the type of data they hold) between local and remote locations, zfsdom can serve you as well (see the [Usage Examples](#usage-examples))

If you're not currently using ZFS, migration is still straightforward and doesn't require downtime—provided your servers support hot-plugging additional storage for ZFS. For further details, see [Migrating Existing VMs to ZFS](#migrating-existing-vms-to-zfs).

## How to Use

### Current Limitations

As of now, `zfsdom` is optimized for virtual machines with the following setup:

- VMs to be live migrated should have a single storage disk, which is a file of any type supported by libvirt.
- This file should reside on its own ZFS dataset, and no other VMs should write to this dataset.

### Prerequisites

- Ensure both source and destination hypervisors are running Linux with ZFS and libvirt installed.
- This tool is tested on Linux systems only and is built against Node.js v18.

### Installation from Binary

1. Download the appropriate Linux x64 binary named `zfsdom` from the Releases page.

2. Give execute permissions to the downloaded binary:

    ```bash
    chmod +x zfsdom
    ```

3. Move the binary to a directory in your PATH, e.g., `/usr/bin`:

    ```bash
    sudo mv zfsdom /usr/bin/
    ```

### Installation from Source

1. Clone the repository:

    ```bash
    git clone https://github.com/staehlil/zfsdom.git
    ```

2. Navigate to the project directory:

    ```bash
    cd zfsdom
    ```

3. Install the necessary Node.js dependencies:

    ```bash
    npm install
    ```

4. Build the project:

    ```bash
    npm run build
    ```

5. Move the built binary to a directory in your PATH, e.g., `/usr/bin`:

    ```bash
    sudo mv ./build/zfsdom-x64 /usr/bin/zfsdom
    ```

### Usage Examples

#### Transfer Command

- Transfer the storage of the local libvirt domain named 'foo' on a ZFS dataset to a dataset sharing the same name on the remote host 'host1':

    ```bash
    zfsdom transfer --domain foo host1
    ```

- Transfer the storage of the local libvirt domain named 'foo' on a ZFS dataset to the dataset 'bar/baz' on the remote host 'host1':

    ```bash
    zfsdom transfer --domain foo host1:bar/baz
    ```

- Transfer the ZFS dataset named 'foo/bar' to a dataset sharing the same name on the remote host 'host1':

    ```bash
    zfsdom transfer --dataset foo/bar host1
    ```

- Transfer the ZFS dataset named 'foo/bar' to a dataset named 'bar/baz' on the remote host 'host1':

    ```bash
    zfsdom transfer --dataset foo/bar host1:bar/baz
    ```

#### Migrate Command

- Live migrate the libvirt domain named 'foo' with its storage residing on a local ZFS dataset to the remote host 'host1':

    ```bash
    zfsdom migrate --domain foo host1
    ```

- Live migrate the libvirt domain named 'foo' with its storage residing on a local ZFS dataset to the remote host 'host1', transferring storage to the ZFS dataset 'bar/baz':

    ```bash
    zfsdom migrate --domain foo host1:bar/baz
    ```

## Migrating Existing VMs to ZFS

If your virtual machines are not currently residing on a ZFS dataset, you'll need to perform a storage migration. Below is a concise guide on how to do this manually using `virsh`.

### Pre-requisites

- Ensure you have enough storage space in your target ZFS dataset for the migration.
- Make sure `virsh` and `qemu-img` tools are installed on your system.

### Steps

1. **Backup Domain XML**: Dump the inactive domain configuration to an XML file.

    ```bash
    virsh dumpxml --inactive <domain> > <domain>.xml
    ```

2. **Undefine Domain**: Remove the domain definition from libvirt. This will not delete your VM; it just removes it from libvirt's list of defined domains.

    ```bash
    virsh undefine <domain>
    ```

3. **Identify Disk to Migrate**: Identify the virtual disk that needs to be migrated. This will typically be a `.qcow2` file.

    ```bash
    disk=$(virsh domblklist <domain> | grep qcow2 | head -1 | awk '{print $1}')
    ```

4. **Perform Block Copy**: Use `virsh blockcopy` to perform a live storage migration. Replace `/path/to/new` with the target ZFS dataset.

    ```bash
    virsh blockcopy <domain> $disk /path/to/new --wait --verbose --pivot
    ```

5. **Edit XML Configuration**: Open the saved XML file (`<domain>.xml`) in a text editor and update the disk path to point to the new ZFS dataset.

    ```xml
    <!-- Locate the <disk> section and change the <source> attribute -->
    <disk type='file' device='disk'>
      <source file='/path/to/new'/>
      <!-- ... -->
    </disk>
    ```

6. **Redefine Domain**: Re-import the updated XML configuration back into libvirt.

    ```bash
    virsh define <domain>.xml
    ```

