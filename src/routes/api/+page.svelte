<script lang="ts">
	const origin = typeof window !== 'undefined' ? window.location.origin : '';

	const snippets = [
		{
			title: 'List drafts',
			code: `curl ${origin}/api/drafts \\
  -H "Authorization: Bearer $COGSEND_API_KEY"`
		},
		{
			title: 'Create a draft and publish it now',
			code: `DRAFT=$(curl -s ${origin}/api/drafts \\
  -H "Authorization: Bearer $COGSEND_API_KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{"baseBody":"Hello from the API"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["draft"]["id"])')
CONNS=$(curl -s ${origin}/api/connections \\
  -H "Authorization: Bearer $COGSEND_API_KEY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["connections"][0]["id"])')
curl ${origin}/api/drafts/$DRAFT/publish \\
  -H "Authorization: Bearer $COGSEND_API_KEY" \\
  -H 'Content-Type: application/json' \\
  -d "{\\"connectionIds\\":[\\"$CONNS\\"]}"`
		},
		{
			title: 'Schedule for later',
			code: `curl ${origin}/api/drafts/$DRAFT/schedule \\
  -H "Authorization: Bearer $COGSEND_API_KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{"connectionIds":["<connection-id>"],"runAt":"2030-01-01T09:00:00Z"}'`
		},
		{
			title: 'Check the queue',
			code: `curl ${origin}/api/queue \\
  -H "Authorization: Bearer $COGSEND_API_KEY"`
		},
		{
			title: 'MCP Inspector CLI (list tools)',
			code: `: "\${COGSEND_API_KEY:?Load it from a secret manager}"\nnpx @modelcontextprotocol/inspector --cli \\
  "${origin}/api/mcp" \\
  --transport http \\
  --protocol-era modern \\
  --method tools/list \\
  --header "Authorization: Bearer $COGSEND_API_KEY"`
		},
		{
			title: 'Generic MCP client configuration template',
			code: `{
  "mcpServers": {
    "cogsend": {
      "type": "http",
      "url": "${origin}/api/mcp",
      "headers": {
        "Authorization": "Bearer $COGSEND_API_KEY"
      }
    }
  }
}`
		}
	];

	async function copy(text: string, btn: HTMLButtonElement) {
		try {
			await navigator.clipboard.writeText(text);
			const prev = btn.textContent;
			btn.textContent = 'Copied';
			btn.setAttribute('aria-live', 'polite');
			setTimeout(() => (btn.textContent = prev), 1500);
		} catch {
			// clipboard unavailable; the snippet is selectable
		}
	}
</script>

<div class="mx-auto flex w-full max-w-2xl flex-1 flex-col py-8 pb-20">
	<div class="mb-12">
		<h1 class="text-3xl font-bold tracking-tight text-stone-900">API Documentation</h1>
		<p class="mt-4 text-[15px] leading-relaxed text-stone-600">
			Use your personal API key for REST API requests or connect an MCP client to the stateless
			Streamable HTTP endpoint at <code>/api/mcp</code>. Generate or revoke your key in
			<a
				href="/settings"
				class="font-medium text-stone-900 underline underline-offset-4 hover:text-stone-600"
				>Settings → API access</a
			>.
		</p>
	</div>

	<div class="flex flex-col gap-12">
		<section>
			<h2 class="mb-4 text-xl font-bold tracking-tight text-stone-900">Authentication</h2>
			<p class="mb-4 text-[15px] leading-relaxed text-stone-600">
				Provide your API key in the headers of every request. You can use the standard
				<code
					class="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[13px] font-medium text-stone-900"
					>Authorization: Bearer &lt;key&gt;</code
				>
				header or the custom
				<code
					class="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[13px] font-medium text-stone-900"
					>X-API-Key: &lt;key&gt;</code
				> header.
			</p>

			<div class="group relative mb-6">
				<pre
					class="overflow-x-auto rounded-xl border border-stone-200/60 bg-stone-50 p-4 font-mono text-[13px] text-stone-900">Authorization: Bearer cog_…</pre>
				<button
					type="button"
					aria-label="Copy authorization header"
					aria-live="polite"
					onclick={(e) => void copy('Authorization: Bearer cog_…', e.currentTarget)}
					class="absolute top-3 right-3 rounded-md border border-stone-200/80 bg-white px-2 py-1 text-xs font-medium text-stone-600 opacity-100 transition-opacity group-hover:opacity-100 hover:bg-stone-100 hover:text-stone-900 focus:opacity-100 focus-visible:opacity-100 sm:opacity-0"
				>
					Copy
				</button>
			</div>

			<ul class="list-disc space-y-2 pl-5 text-[15px] text-stone-600 marker:text-stone-500">
				<li>
					<strong class="font-medium text-stone-900">Capabilities:</strong> The API key can be used to
					manage drafts, upload media, publish posts, schedule deliveries, and read queue status.
				</li>
				<li>
					<strong class="font-medium text-stone-900">Restrictions:</strong> The key cannot be used to
					connect or disconnect social accounts, rotate credentials, or revoke itself. These actions require
					a secure browser session.
				</li>
				<li>
					<strong class="font-medium text-stone-900">Scopes:</strong> Choose
					<strong>Read-only</strong> or <strong>Read + write</strong> when generating or replacing a key;
					Read + write is the default and includes read access. A read-only key can use MCP's connection,
					draft, validation, and queue tools; write tools require Read + write. The detailed MCP tool
					map is below.
				</li>
				<li>
					<strong class="font-medium text-stone-900">Key lifecycle:</strong> Only one personal key is
					active at a time. The raw key is shown once and only its hash is stored. Generating a replacement
					immediately revokes the previous key.
				</li>
				<li>
					<strong class="font-medium text-stone-900">Errors:</strong> Failed requests return a JSON
					object with an
					<code class="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[13px]">error</code> property.
				</li>
				<li>
					<strong class="font-medium text-stone-900">Publishing:</strong> Direct publishes return
					per-connection results inline. Reusing a connection within the same draft returns
					<code class="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[13px]">skipped</code>.
					Scheduling a duplicate target returns a 409 Conflict.
				</li>
			</ul>
			<p class="mt-6 text-[14px] font-medium text-stone-500">
				If a key ever touches a log or screenshot, rotate it in Settings — the old one stops working
				immediately.
			</p>
		</section>

		<section>
			<h2 class="mb-6 text-xl font-bold tracking-tight text-stone-900">Endpoints</h2>
			<dl class="space-y-3 font-mono text-[13px] text-stone-600">
				<div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="shrink-0 font-semibold text-stone-900 sm:w-[280px]">POST /api/mcp</dt>
					<dd>stateless Streamable HTTP MCP endpoint; personal bearer key required</dd>
				</div>
				<div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="shrink-0 font-semibold text-stone-900 sm:w-[280px]">GET /api/drafts</dt>
					<dd>list drafts with variants, media, targets</dd>
				</div>
				<div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="shrink-0 font-semibold text-stone-900 sm:w-[280px]">POST /api/drafts</dt>
					<dd>{'{"title?", "baseBody?", "selectedConnectionIds?"} → 201 {draft}'}</dd>
				</div>
				<div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="shrink-0 font-semibold text-stone-900 sm:w-[280px]">PATCH /api/drafts/:id</dt>
					<dd>edit title/body/selectedConnectionIds (409 while publishing)</dd>
				</div>
				<div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="shrink-0 font-semibold text-stone-900 sm:w-[280px]">
						PUT /api/drafts/:id/variants
					</dt>
					<dd>{'{"platform", "body?", "options?"} → the per-platform copy'}</dd>
				</div>
				<div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="shrink-0 font-semibold text-stone-900 sm:w-[280px]">
						POST /api/drafts/:id/media
					</dt>
					<dd>{'multipart: file(s), segmentIndex, altText? → 201 {media}'}</dd>
				</div>
				<div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="shrink-0 font-semibold text-stone-900 sm:w-[280px]">
						POST /api/drafts/:id/duplicate
					</dt>
					<dd>clone a draft (media included) into a new draft</dd>
				</div>
				<div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="shrink-0 font-semibold text-stone-900 sm:w-[280px]">
						GET|POST|DELETE /api/drafts/:id/share
					</dt>
					<dd>
						{'read-only preview link: POST {"expiresInDays?"} (default 14, max 30) → 201 {share:{url, expiresAt}}; a new one replaces the old'}
					</dd>
				</div>
				<div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="shrink-0 font-semibold text-stone-900 sm:w-[280px]">
						POST /api/drafts/:id/publish
					</dt>
					<dd>{'{"connectionIds":[]} → {results[], draft}'}</dd>
				</div>
				<div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="shrink-0 font-semibold text-stone-900 sm:w-[280px]">
						POST /api/drafts/:id/schedule
					</dt>
					<dd>{'{"connectionIds":[],"runAt":ISO} → {targets}'}</dd>
				</div>
				<div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="shrink-0 font-semibold text-stone-900 sm:w-[280px]">GET /api/queue</dt>
					<dd>upcoming + recent delivery targets</dd>
				</div>
				<div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="shrink-0 font-semibold text-stone-900 sm:w-[280px]">
						POST /api/targets/:id/cancel|retry
					</dt>
					<dd>cancel or retry one delivery</dd>
				</div>
				<div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="shrink-0 font-semibold text-stone-900 sm:w-[280px]">POST /api/targets/bulk</dt>
					<dd>cancel, retry, or reschedule several deliveries at once</dd>
				</div>
				<div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="shrink-0 font-semibold text-stone-900 sm:w-[280px]">GET /api/connections</dt>
					<dd>account ids, platforms, statuses, and which platforms this deployment can connect</dd>
				</div>
			</dl>
		</section>

		<section aria-labelledby="mcp-server-heading">
			<h2 id="mcp-server-heading" class="mb-4 text-xl font-bold tracking-tight text-stone-900">
				MCP server
			</h2>
			<p class="mb-4 text-[15px] leading-relaxed text-stone-600">
				Connect to <code class="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[13px]"
					>{origin}/api/mcp</code
				>
				using Streamable HTTP. Send an active personal key in
				<code class="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[13px]"
					>Authorization: Bearer …</code
				>
				on every request. MCP does not accept cookies, <code>X-API-Key</code>, the legacy
				<code>API_TOKEN</code>, scheduler credentials, or query-string credentials. Requests are
				stateless JSON. Tool results include text summaries and structured data; GET and DELETE
				return 405. If Cloudflare Access protects the instance with Service Auth, also send
				<code>CF-Access-Client-Id</code>
				and
				<code>CF-Access-Client-Secret</code> using locally stored environment values. The Access guide
				covers the policy choice for clients that cannot send these headers.
			</p>
			<p class="mb-3 text-[15px] leading-relaxed text-stone-600">
				<strong class="font-medium text-stone-900">Read scope:</strong>
				<code>list_connections</code>, <code>list_drafts</code>, <code>get_draft</code>,
				<code>validate_post</code>, <code>list_queue</code>.
			</p>
			<p class="mb-4 text-[15px] leading-relaxed text-stone-600">
				<strong class="font-medium text-stone-900">Write scope:</strong>
				<code>create_draft</code>, <code>update_draft</code>, <code>duplicate_draft</code>,
				<code>delete_draft</code>, <code>set_draft_variant</code>,
				<code>delete_draft_variant</code>,
				<code>publish_draft</code>, <code>schedule_draft</code>, <code>cancel_delivery</code>,
				<code>retry_delivery</code>, <code>reschedule_delivery</code>. Write includes read.
			</p>
			<p class="mb-4 text-[14px] leading-relaxed text-stone-600">
				The tools annotated as destructive are <code>update_draft</code>,
				<code>set_draft_variant</code>, <code>delete_draft</code>,
				<code>delete_draft_variant</code>,
				<code>publish_draft</code>, <code>schedule_draft</code>, <code>cancel_delivery</code>,
				<code>retry_delivery</code>, and <code>reschedule_delivery</code>.
				<code>publish_draft</code>
				and
				<code>retry_delivery</code> are also open-world operations. Verify content, destination, and timing
				before approving publish, retry, schedule, or reschedule.
			</p>
			<div class="mb-6 rounded-xl border border-amber-200/70 bg-amber-50/60 p-4">
				<p class="text-[14px] leading-relaxed text-amber-950">
					Use an MCP client that asks you to approve destructive and open-world actions. Review
					content and destination before <code>publish_draft</code> or <code>retry_delivery</code>,
					which can post to external services. Tool annotations are hints, not authorization or
					enforced consent; CogSend has no server-side preview/commit step in v1.
				</p>
				<p class="mt-2 text-[14px] leading-relaxed text-amber-950">
					MCP v1 does not expose media operations, settings, insights, account/provider management,
					key management, scheduler administration, the internal publish endpoint, arbitrary HTTP
					requests, prompts, resources, or sampling. The current SDK revision does not implement MCP <code
						>ping</code
					>; a ping can return JSON-RPC
					<code>-32601</code> / HTTP 404.
				</p>
			</div>
			<h3 class="mb-2 text-[15px] font-semibold text-stone-900">Try it with MCP Inspector</h3>
			<ol class="mb-4 list-decimal space-y-2 pl-5 text-[14px] leading-relaxed text-stone-600">
				<li>
					Generate a Read-only or Read + write key in Settings and copy it while it is shown once.
				</li>
				<li>
					Run <code>npx @modelcontextprotocol/inspector</code> to open the official Inspector.
				</li>
				<li>
					Choose Streamable HTTP, enter the endpoint above, and configure the Authorization header
					with your key. Connect and try <code>list_connections</code>.
				</li>
				<li>
					Review the arguments before invoking destructive or open-world tools; configure agent
					clients to require your approval.
				</li>
			</ol>
			<p class="text-[13px] leading-relaxed text-stone-500">
				The copyable CLI example below uses shell expansion for <code>$COGSEND_API_KEY</code>. The
				generic configuration is a template: client-specific variable interpolation is not
				guaranteed. Never commit a real key.
			</p>
		</section>

		<section>
			<h2 class="mb-6 text-xl font-bold tracking-tight text-stone-900">Examples</h2>
			<div class="flex flex-col gap-8">
				{#each snippets as s (s.title)}
					<div>
						<h3 class="mb-3 text-[15px] font-semibold text-stone-900">{s.title}</h3>
						<div class="group relative">
							<pre
								class="overflow-x-auto rounded-xl border border-stone-200/60 bg-stone-50 p-4 font-mono text-[13px] text-stone-900">{s.code}</pre>
							<button
								type="button"
								aria-label={`Copy ${s.title} snippet`}
								aria-live="polite"
								onclick={(e) => void copy(s.code, e.currentTarget)}
								class="absolute top-3 right-3 rounded-md border border-stone-200/80 bg-white px-2 py-1 text-xs font-medium text-stone-600 opacity-100 transition-opacity group-hover:opacity-100 hover:bg-stone-100 hover:text-stone-900 focus:opacity-100 focus-visible:opacity-100 sm:opacity-0"
							>
								Copy
							</button>
						</div>
					</div>
				{/each}
			</div>
		</section>
	</div>
</div>
