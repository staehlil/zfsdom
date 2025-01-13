const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const Zfsdom = require('./src/zfsdom.js');

const argv = yargs(hideBin(process.argv))
    .command(
        'transfer [dest]',
        'Transfer ZFS datasets by name or domain from local to remote destination',
        (yargs) => {
          return yargs
              .option('domain', {
                description: 'Specify local libvirt domain with storage residing on ZFS dataset',
                type: 'string',
              })
              .option('dataset', {
                description: 'Specify local dataset',
                type: 'string',
              })
              .positional('dest', {
                description: 'Destination host and dataset (optional) specified as HOSTNAME[:DATASET]. The dataset name only has to be provided if it differs from the one on the source host (asymmetric transfer).',
                type: 'string',
                demandOption: true,
              })
              .check((argv) => {
                if (argv.domain && argv.dataset) {
                  throw new Error('Only one of --domain or --dataset should be provided.');
                }
                if (!argv.domain && !argv.dataset) {
                  throw new Error('One of --domain or --dataset should be provided.');
                }
                return true;
              })
              .example("transfer --domain foo host1", "transfer the storage of the local libvirt domain named 'foo' on a ZFS dataset to a dataset sharing the same name on the remote host 'host1' (symmetric transfer)")
              .example("transfer --domain foo host1:bar/baz", "transfer the storage of the local libvirt domain named 'foo' on a ZFS dataset to the dataset 'bar/baz' on the remote host 'host1' (asymmetric transfer)")
              .example("transfer --dataset foo/bar host1", "transfer the ZFS dataset named 'foo/bar' to a dataset sharing the same name on the remote host 'host1'  (symmetric transfer)")
              .example("transfer --dataset foo/bar host1:bar/baz", "transfer the ZFS dataset named 'foo/bar' to a dataset named 'bar/baz' on the remote host 'host1' (asymmetric transfer)")
        }
    )
    .command(
        'migrate [dest]',
        'Migrate a libvirt domain with its storage residing on a ZFS dataset',
        (yargs) => {
          return yargs
              .option('domain', {
                description: 'Specify local libvirt domain with storage residing on ZFS dataset',
                type: 'string',
              })
              .positional('dest', {
                description: 'Destination host and dataset (optional) specified as HOSTNAME[:DATASET]. The dataset name only has to be provided if it differs from the one on the source host (asymmetric transfer).',
                type: 'string',
                demandOption: true,
              })
              .check((argv) => {
                if (!argv.domain) {
                  throw new Error('--domain should be provided.');
                }
                return true;
              })
              .example("migrate --domain foo host1", "live (suspended) migrate the libvirt domain named 'foo' with its storage residing on a local ZFS dataset to the remote host 'host1', transferring storage to a ZFS dataset with the same name as the source (symmetric transfer)")
              .example("migrate --domain foo host1:bar/baz", "live (suspended) migrate the libvirt domain named 'foo' with its storage residing on a local ZFS dataset to the remote host 'host1', transferring storage to the ZFS dataset 'bar/baz' (asymmetric transfer)")
        }
    )
    .command(
        'list-domains [host]',
        'List libvirt domains running on target host',
        (yargs) => {
          return yargs
              .positional('host', {
                description: 'Target host and port (optional) specified as HOSTNAME[:PORT]',
                type: 'string',
                demandOption: true,
              })
              .option('all', {
                description: 'List all domains, regardless of state (default: list only running domains)',
                type: 'boolean',
              })
              .option('plain', {
                description: 'Plain output (default: json)',
                type: 'boolean',
              })
              .check((argv) => {
                if (!argv.host) {
                  throw new Error('host should be provided.');
                }
                return true;
              })
        }
    )
    .option('do', {
      description: 'only actually do anything if set to true, dry-run otherwise',
      type: 'boolean',
    })
    .option('force', {
      alias: 'f',
      description: 'if set, rollback incremental snapshot source on destination if modified or discard existing datasets contents if no snapshot exists on destination',
      type: 'boolean',
    })
    .demandCommand(1, 'You need at least one command before moving on')
    .help()
    .alias('help', 'h')
    .argv;

const action = argv._[0];

if (action === 'migrate' && argv['dest']) {
  new Zfsdom().migrateDomain(argv.domain, argv['dest'], argv.do, argv.force)
      .catch(err => console.error((err + "").trim()));
} else if (action === 'transfer' && argv['dest']) {
  if (argv.domain) {
    new Zfsdom().transferDomainSnapshot(argv.domain, argv['dest'], argv.do, argv.force)
        .catch(err => console.error((err + "").trim()));
  } else if (argv.dataset) {
    new Zfsdom().transferSnapshotByDataset(argv.dataset, argv['dest'], argv.do, argv.force)
        .catch(err => console.error((err + "").trim()));
  } else {
    console.log('Please provide either --dataset or --domain argument for transferring.');
  }
} else if (action === 'list-domains') {
  (async ()=>{
    let domains = await new Zfsdom().getDomains(argv.host,argv.all||false)
          .catch(err => console.error((err + "").trim()));
    console.log(argv.plain ? domains.map(i=>Object.keys(i).map(k=>i[k]).join(",")).join("\n") : JSON.stringify(domains,null,2));
  })();
} else {
  console.log('Invalid command or missing required arguments.');
}
