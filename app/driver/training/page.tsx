"use client";

// Driver training (D13): the lesson list, and one lesson at a time (?lesson=key) with its text,
// illustration and quiz. complete_training_lesson() grades the quiz and records a pass (0030).
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useDriver, type LessonResult } from "@/components/DriverContext";
import { DICT, useFmt } from "@/components/driver/i18n";
import { TrainingArt } from "@/components/driver/TrainingArt";
import { LESSONS, lessonByKey, type Lesson } from "@/components/driver/training";
import { Icon } from "@/components/icons";
import { BackButton, Loading } from "@/components/Shell";
import { LangToggle, useLang, useT } from "@/lib/i18n";

export default function TrainingPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Training />
    </Suspense>
  );
}

function Training() {
  const key = useSearchParams().get("lesson");
  const lesson = lessonByKey(key);
  return lesson ? <LessonView key={lesson.key} lesson={lesson} /> : <LessonList />;
}

function LessonList() {
  const { training } = useDriver();
  const t = useT(DICT);
  const f = useFmt();
  const { lang } = useLang();
  const n = LESSONS.filter((l) => training.done.includes(l.key)).length;
  return (
    <main className="screen">
      <div className="ptop">
        <BackButton href="/driver/profile" label={t("tProfile")} />
        <h3 style={{ flex: 1 }}>{t("training")}</h3>
        <LangToggle />
      </div>
      <p className="mut small" style={{ marginTop: 0 }}>
        {t("trainingS")}
      </p>
      <div className={`banner ${training.complete ? "okb" : ""}`} role="status">
        {training.complete ? t("trainingAll") : t("trainingProgress", { n: f.d(n), m: f.d(LESSONS.length) })}
      </div>
      {LESSONS.map((l, i) => {
        const done = training.done.includes(l.key);
        return (
          <Link key={l.key} href={`/driver/training?lesson=${l.key}`} className="lrow">
            <span>
              {f.d(i + 1)}. {l.title[lang]}
              <small>{t("trainingMin", { n: f.d(l.minutes) })}</small>
            </span>
            {done ? <span className="st ok">{t("trainingDone")}</span> : <span className="st warn">{t("trainingTodo")}</span>}
          </Link>
        );
      })}
      {training.source === "prefs" && <p className="mut small">{t("trainingSaved")}</p>}
    </main>
  );
}

function LessonView({ lesson }: { lesson: Lesson }) {
  const { submitLesson, training } = useDriver();
  const router = useRouter();
  const t = useT(DICT);
  const f = useFmt();
  const { lang } = useLang();
  const idx = LESSONS.indexOf(lesson);
  const next = LESSONS[idx + 1] ?? null;
  const [answers, setAnswers] = useState<(number | null)[]>(lesson.quiz.map(() => null));
  const [result, setResult] = useState<LessonResult | null>(null);
  const [busy, setBusy] = useState(false);
  const passedBefore = training.done.includes(lesson.key);

  async function check() {
    if (answers.some((a) => a === null)) return;
    setBusy(true);
    const r = await submitLesson(lesson.key, answers as number[]);
    setBusy(false);
    if (r) setResult(r);
  }
  const retry = () => {
    setResult(null);
    setAnswers(lesson.quiz.map(() => null));
  };

  return (
    <main className="screen">
      <div className="ptop">
        <BackButton href="/driver/training" label={t("backToTraining")} />
        <div style={{ flex: 1 }}>
          <h3>{lesson.title[lang]}</h3>
          <div className="sub">
            {t("lessonN", { n: f.d(idx + 1), m: f.d(LESSONS.length) })} · {t("trainingMin", { n: f.d(lesson.minutes) })}
          </div>
        </div>
        {passedBefore && <span className="st ok">{t("trainingDone")}</span>}
      </div>
      <TrainingArt lesson={lesson.key} label={lesson.title[lang]} />
      <div className="tr-body">
        {lesson.body.map((p, i) => (
          <p key={i}>{p[lang]}</p>
        ))}
      </div>

      <h4 className="d-h4">{t("quizT")}</h4>
      {lesson.quiz.map((q, qi) => {
        const shown = result !== null;
        const right = answers[qi] === q.answer;
        return (
          <fieldset key={qi} className="tr-q" disabled={shown || busy}>
            <legend>
              <small className="mut">{t("quizQ", { n: f.d(qi + 1) })}</small>
              <b className="d-block">{q.q[lang]}</b>
            </legend>
            {q.options.map((o, oi) => (
              <label key={oi} className={`tr-opt${answers[qi] === oi ? " on" : ""}${shown && oi === answers[qi] ? (right ? " ok" : " bad") : ""}`}>
                <input type="radio" name={`q${qi}`} checked={answers[qi] === oi} onChange={() => setAnswers((a) => a.map((v, k) => (k === qi ? oi : v)))} />
                <span>{o[lang]}</span>
              </label>
            ))}
            {shown && (
              <p className={`small ${right ? "okt" : "badt"}`} style={{ margin: "6px 0 0" }}>
                <Icon name={right ? "check" : "alert"} size={14} /> {right ? t("quizRight") : t("quizWrong")} {right ? q.why[lang] : ""}
              </p>
            )}
          </fieldset>
        );
      })}

      {result ? (
        <>
          <div className={`banner ${result.passed ? "okb" : "badb"}`} role="status">
            {t(result.passed ? "quizPassed" : "quizFailed", { c: f.d(result.correct), t: f.d(result.total) })}
          </div>
          {result.passed ? (
            next ? (
              <button className="cta" onClick={() => router.push(`/driver/training?lesson=${next.key}`)}>
                {t("nextLesson")}
              </button>
            ) : (
              <button className="cta" onClick={() => router.push("/driver/training")}>
                {t("backToTraining")}
              </button>
            )
          ) : (
            <button className="cta" onClick={retry}>
              {t("quizRetry")}
            </button>
          )}
        </>
      ) : (
        <button className="cta" disabled={busy || answers.some((a) => a === null)} onClick={check}>
          {busy ? t("quizChecking") : t("quizSubmit")}
        </button>
      )}
    </main>
  );
}
