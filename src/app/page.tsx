import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/server/auth/current-user';

export default async function RootPage() {
  const user = await getCurrentUser();
  redirect(user ? '/dashboard' : '/login');
}
