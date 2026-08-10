(function (root) {
  root.supabase = {
    createClient: function () {
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
