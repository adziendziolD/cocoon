import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from './api/rpc';
import { App } from './App';
import { ToastProvider } from './components/Toast';
import { LanguageProvider } from './i18n';
import { consumeTokenFromUrl, getToken, subscribeToken } from './lib/auth';
import './index.css';

consumeTokenFromUrl();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Live updates arrive via WebSocket, so data stays fresh without aggressive refetching.
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && ['unauthorized', 'not_found', 'bad_request'].includes(err.code)) && count < 2,
    },
  },
});

// Drop all cached data when the user logs out or switches tokens.
let lastToken = getToken();
subscribeToken(() => {
  const t = getToken();
  if (t !== lastToken) queryClient.clear();
  lastToken = t;
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </LanguageProvider>
    </QueryClientProvider>
  </StrictMode>,
);
