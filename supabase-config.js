// 月度安全會議報告系統 - 公開 Supabase 設定
// 只允許放 Supabase anon public key；不要放任何後台密鑰。
// 這個 Workspace Key 代表同一份共享雲端資料；知道此 key 的人可讀寫這個工作區。
window.MONTHLY_REPORT_SUPABASE_CONFIG = {
  supabaseUrl: "https://pgkemqnqhtfssxeodavu.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBna2VtcW5xaHRmc3N4ZW9kYXZ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1ODgzMjAsImV4cCI6MjA5ODE2NDMyMH0.e-DqurNHYixWm2h06MsgDKN1cvNjx9NYXENdZ5GZQHY",
  workspaceKey: "monthly-653e09025d14152ade450461d23168b71bda",
  autoSyncOnOpen: true,
  autoSave: true,
  autoSaveDelayMs: 2500
};
