(function (root) {
  function encodePath(path) {
    return String(path || '').split('/').map(encodeURIComponent).join('/');
  }

  root.supabase = {
    createClient: function (supabaseUrl) {
      const baseUrl = String(supabaseUrl || root.location.origin).replace(/\/$/, '');
      const session = { access_token: 'fake-anonymous-token', user: { id: 'fake-auth-user' } };
      return {
        auth: {
          async getSession() { return { data: { session }, error: null }; },
          async signInAnonymously() { return { data: { session }, error: null }; }
        },
        async rpc(name, params) {
          try {
            const response = await fetch('/__fake_rpc', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name, params: params || {} })
            });
            const data = await response.json();
            return response.ok ? { data, error: null } : { data: null, error: data };
          } catch (error) { return { data: null, error }; }
        },
        storage: {
          from(bucket) {
            return {
              async upload(path, file, options) {
                try {
                  const endpoint = new URL('/__fake_storage_upload', baseUrl);
                  endpoint.searchParams.set('bucket', String(bucket || ''));
                  endpoint.searchParams.set('path', String(path || ''));
                  endpoint.searchParams.set('upsert', String(Boolean(options && options.upsert)));
                  const response = await fetch(endpoint.href, {
                    method: 'POST',
                    headers: {
                      'Content-Type': String(options && options.contentType || file && file.type || 'application/octet-stream'),
                      'X-Cache-Control': String(options && options.cacheControl || '')
                    },
                    body: file
                  });
                  const data = await response.json();
                  return response.ok ? { data: { path: data.path }, error: null } : { data: null, error: data };
                } catch (error) { return { data: null, error }; }
              },
              getPublicUrl(path) {
                return {
                  data: {
                    publicUrl: `${baseUrl}/storage/v1/object/public/${encodeURIComponent(String(bucket || ''))}/${encodePath(path)}`
                  }
                };
              }
            };
          }
        },
        channel() {
          const channel = {
            on() { return channel; },
            subscribe() { return channel; }
          };
          return channel;
        },
        removeChannel() { return Promise.resolve('ok'); }
      };
    }
  };
})(window);
