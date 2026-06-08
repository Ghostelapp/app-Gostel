import axios, { AxiosInstance } from 'axios';
import { getStoredToken, TOKEN_KEY } from './tokenStorage';

export { TOKEN_KEY };

export const BASE_URL = process.env.EXPO_PUBLIC_BACKEND_URL || 'https://api.ghostel.app';

export const api: AxiosInstance = axios.create({
  baseURL: `${BASE_URL}/api`,
  timeout: 20000,
});

api.interceptors.request.use(async (config) => {
  const token = await getStoredToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export function formatApiErrorDetail(err: any): string {
  const detail = err?.response?.data?.detail;
  if (detail == null) return err?.message || 'Something went wrong';
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((e: any) => (e && typeof e.msg === 'string' ? e.msg : JSON.stringify(e)))
      .filter(Boolean)
      .join(' ');
  }
  if (detail && typeof detail.msg === 'string') return detail.msg;
  return String(detail);
}
