-- ================================================
-- FORGE DATABASE SCHEMA
-- Run this in Supabase SQL Editor
-- ================================================

-- USER PROFILES (extends Supabase auth.users)
create table public.profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  name text,
  age integer,
  sex text,
  height_cm numeric,
  weight_kg numeric,
  goal text,              -- 'muscle', 'fat_loss', 'strength', 'endurance'
  experience text,        -- 'beginner', 'intermediate', 'advanced'
  days_per_week integer,
  equipment text,         -- 'full_gym', 'home_gym', 'minimal'
  diet_restrictions text, -- free text e.g. "no soy, no tofu"
  diet_style text,        -- 'anything', 'vegetarian', 'vegan', 'keto'
  injuries text,
  target_weight_kg numeric,
  onboarding_complete boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- GENERATED PLANS (AI-generated per user)
create table public.plans (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles(id) on delete cascade,
  workout_plan jsonb,     -- full PPL/push-pull/etc plan
  nutrition_plan jsonb,   -- meals, macros
  generated_at timestamptz default now()
);

-- SESSION LOGS
create table public.session_logs (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles(id) on delete cascade,
  day_index integer,      -- 0=Mon, 1=Tue etc
  day_label text,
  logged_at date default current_date,
  exercises jsonb,        -- [{name, weight, reps, sets, vol}, ...]
  created_at timestamptz default now()
);

-- EXERCISE HISTORY (per-exercise overload tracking)
create table public.exercise_history (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles(id) on delete cascade,
  exercise_name text,
  logged_at date default current_date,
  weight_kg numeric,
  reps integer,
  sets integer,
  volume numeric,
  est_1rm numeric,
  created_at timestamptz default now()
);

-- PERSONAL RECORDS
create table public.personal_records (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles(id) on delete cascade,
  exercise_name text,
  weight_kg numeric,
  reps integer,
  sets integer,
  est_1rm numeric,
  achieved_at date default current_date,
  unique(user_id, exercise_name)
);

-- BODYWEIGHT LOG
create table public.bodyweight_log (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles(id) on delete cascade,
  weight_kg numeric,
  logged_at date default current_date,
  created_at timestamptz default now()
);

-- ── ROW LEVEL SECURITY ──────────────────────────
-- Users can only see and edit their own data

alter table public.profiles enable row level security;
alter table public.plans enable row level security;
alter table public.session_logs enable row level security;
alter table public.exercise_history enable row level security;
alter table public.personal_records enable row level security;
alter table public.bodyweight_log enable row level security;

-- Profiles
create policy "Users can view own profile" on public.profiles for select using (auth.uid() = id);
create policy "Users can update own profile" on public.profiles for update using (auth.uid() = id);
create policy "Users can insert own profile" on public.profiles for insert with check (auth.uid() = id);

-- Plans
create policy "Users can view own plans" on public.plans for select using (auth.uid() = user_id);
create policy "Users can insert own plans" on public.plans for insert with check (auth.uid() = user_id);

-- Session logs
create policy "Users can manage own logs" on public.session_logs for all using (auth.uid() = user_id);

-- Exercise history
create policy "Users can manage own history" on public.exercise_history for all using (auth.uid() = user_id);

-- PRs
create policy "Users can manage own PRs" on public.personal_records for all using (auth.uid() = user_id);

-- Bodyweight
create policy "Users can manage own bodyweight" on public.bodyweight_log for all using (auth.uid() = user_id);

-- ── AUTO-CREATE PROFILE ON SIGNUP ──────────────
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id)
  values (new.id);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
