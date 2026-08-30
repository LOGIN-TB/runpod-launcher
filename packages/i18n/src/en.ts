/**
 * The reference locale. Add keys here first; every other locale is typed
 * against this object, so a missing translation fails the build.
 */
export const en = {
  'app.name': 'RunPod Launcher',
  'app.tagline': 'Your own model on rented hardware',

  'nav.overview': 'Overview',
  'nav.templates': 'Templates',
  'nav.clients': 'Clients',
  'nav.settings': 'Settings',
  'nav.help': 'Help',

  'action.save': 'Save',
  'action.cancel': 'Cancel',
  'action.delete': 'Delete',
  'action.retry': 'Try again',
  'action.copy': 'Copy',
  'action.copied': 'Copied',
  'action.close': 'Close',

  'pairing.title': 'Connect to your service',
  'pairing.intro':
    'The launcher service runs next to whatever uses your model. Enter its address and the pairing code it printed on first start.',
  'pairing.address': 'Service address',
  'pairing.addressHint': 'For example http://192.168.1.20:8080 or https://launcher.example.com',
  'pairing.code': 'Pairing code',
  'pairing.codeHint': 'Shown in the container log, or in Coolify under the environment variables',
  'pairing.deviceName': 'Name for this device',
  'pairing.submit': 'Pair',
  'pairing.failed': 'Pairing failed: {reason}',
  'pairing.noService': 'No service answered at that address. Is the container running?',

  'pod.title': 'Model',
  'pod.start': 'Start',
  'pod.stop': 'Stop',
  'pod.starting': 'Starting — this takes a few minutes',
  'pod.running': 'Running',
  'pod.stopped': 'Stopped',
  'pod.none': 'No pod yet',
  'pod.noneHint': 'Pick a template and start it. Nothing is billed until you do.',
  'pod.costToday': 'Today',
  'pod.costPerHour': '{amount} per hour',
  'pod.uptime': 'Running for {duration}',
  'pod.endpoint': 'Endpoint for your clients',

  'template.title': 'Templates',
  'template.none': 'No templates yet',
  'template.noneHint': 'A template says what to run: a model, a GPU, and when it may sleep.',
  'template.new': 'New template',
  'template.name': 'Name',
  'template.chatModel': 'Chat model',
  'template.embeddingModel': 'Embedding model',
  'template.slotOff': 'Not used',
  'template.slotOn': 'In use',
  'template.gpu': 'Graphics card',
  'template.advanced': 'Advanced',
  'template.contextLength': 'Context length',
  'template.sleepMode': 'When idle',
  'template.sleepStopResume': 'Pause and resume',
  'template.sleepStopResumeHint':
    'Keeps the machine, so it wakes in a minute or two. Storage bills at double rate while paused.',
  'template.sleepRecreate': 'Rebuild each time',
  'template.sleepRecreateHint':
    'Cheaper at rest, but pins the pod to one data centre — where free cards are scarcest.',

  'model.search': 'Search HuggingFace',
  'model.searchHint': 'Or paste a repository name such as Qwen/Qwen3.8-27B-FP8',
  'model.checking': 'Checking…',
  'model.fits': 'Fits: {weights} of weights, about {headroom} left for context',
  'model.wontFit': 'Will not work here',
  'model.downloads': '{count} downloads',
  'model.gguf.pick': 'Quantisation',

  'clients.title': 'Client access',
  'clients.intro':
    'Give each client its own token. A client token can use the model and nothing else — it cannot start a pod or read your settings.',
  'clients.new': 'New token',
  'clients.name': 'What is this for?',
  'clients.namePlaceholder': 'n8n, my agent, a script…',
  'clients.created': 'Copy this now. It is never shown again.',
  'clients.lastUsed': 'Last used {when}',
  'clients.neverUsed': 'Never used',
  'clients.revoke': 'Revoke',
  'clients.revoked': 'Revoked',
  'clients.recipe': 'How to connect',

  'settings.title': 'Settings',
  'settings.runpodKey': 'RunPod API key',
  'settings.runpodKeyHint': 'Needed to rent hardware. Stored encrypted; never shown again.',
  'settings.hfToken': 'HuggingFace token',
  'settings.hfTokenHint': 'Optional. Speeds up downloads and unlocks gated models.',
  'settings.webhook': 'Notification webhook',
  'settings.webhookHint': 'Where alerts go — an n8n webhook, or anything that accepts a POST.',
  'settings.set': 'Set',
  'settings.notSet': 'Not set',
  'settings.replace': 'Replace',
  'settings.verify': 'Check key',
  'settings.verified': 'The key works',
  'settings.verifyFailed': 'RunPod rejected this key',
  'settings.language': 'Language',
  'settings.spendLimits': 'Spending limits',
  'settings.dailyLimit': 'Stop at, per day',
  'settings.monthlyLimit': 'Stop at, per month',

  'problem.format-engine-mismatch':
    '{format} weights cannot be served by {engine}. It reads {supported}.',
  'problem.fp8-unsupported-gpu':
    '{gpu} has no hardware FP8. It would run slower here than a 4-bit build.',
  'problem.does-not-fit': '{weightsGib} GiB of weights leave no room on a {cardGib} GiB card.',
  'problem.does-not-fit-with-other':
    '{weightsGib} GiB of weights leave no room on a {cardGib} GiB card alongside the other model’s {otherGib} GiB.',
  'problem.tight-headroom':
    'Only {headroomGib} GiB would be left for context. Expect a very short context window.',
  'problem.repo-gated':
    '{repoId} is gated. Accept its terms on HuggingFace, then add a token with access in Settings.',
  'problem.repo-missing': 'No repository called {repoId}, or that revision does not exist.',
  'problem.hub-error': 'HuggingFace answered with {status}.',

  'error.generic': 'Something went wrong: {message}',
  'error.offline': 'Cannot reach the service.',
} as const
