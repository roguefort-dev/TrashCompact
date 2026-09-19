export function installerArgs(argv, allowed = ['codex', 'claude', 'opencode', 'opencode2']) {
  let target = 'codex', remove = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target' && allowed.includes(argv[i + 1])) target = argv[++i];
    else if (argv[i] === '--remove') remove = true;
    else throw new Error('Expected --target ' + allowed.join('|') + ' and optional --remove');
  }
  return { target, remove };
}
