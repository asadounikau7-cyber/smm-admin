import { loginAction } from "@/app/actions";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const { e } = await searchParams;
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form action={loginAction} className="card w-full max-w-sm space-y-4 p-6">
        <h1 className="text-lg font-semibold">Вход в админку</h1>
        {e && <div className="rounded-md bg-red-100 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">Неверный email или пароль</div>}
        <div>
          <label className="label">Email</label>
          <input name="email" type="email" required autoComplete="username" className="input" />
        </div>
        <div>
          <label className="label">Пароль</label>
          <input name="password" type="password" required autoComplete="current-password" className="input" />
        </div>
        <button className="btn btn-primary w-full justify-center">Войти</button>
      </form>
    </div>
  );
}
