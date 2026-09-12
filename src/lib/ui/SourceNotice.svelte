<script lang="ts">
  import licenseText from '../../../LICENSE?raw'
  import notices from '../../../NOTICE?raw'
  const revision = /^[0-9a-f]{7,40}$/.test(__APP_BUILD__) ? __APP_BUILD__ : null
  const base = 'https://github.com/srcfl/ftw-webapp'
</script>

<details class="source-notice">
  <summary>Source &amp; licenses</summary>
  <p>© 2026 Sourceful Labs AB and contributors. AGPLv3 with the Energyplan
    combination permission. You may copy, modify and redistribute this app
    under its license. No warranty to the extent permitted by law.</p>
  <a href={revision ? `${base}/archive/${revision}.tar.gz` : base} target="_blank" rel="noreferrer">
    {revision ? 'Download this app’s source' : 'Source repository (development build)'}
  </a>
  <details>
    <summary>Read license</summary>
    <pre>{licenseText}</pre>
  </details>
  <details>
    <summary>Earlier licenses and notices</summary>
    <pre>{notices}</pre>
  </details>
</details>

<style>
  .source-notice { padding: 1rem; font-size: .75rem; color: var(--fg-dim); }
  summary { cursor: pointer; }
  details details { margin-top: .75rem; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 24rem; overflow-y: auto; }
  a { color: inherit; text-decoration: underline; }
</style>
