import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import { Clock, AlertCircle, CheckCircle } from 'lucide-react';

interface Question {
  id: string;
  question_text: string;
  question_type: 'mcq' | 'multiple_correct';
  options: { id: string; text: string }[];
  correct_answers: string[];
  marks: number;
  order_index: number;
}

interface Answer {
  question_id: string;
  selected_answers: string[];
}

export const TakeTest = ({
  testId,
  testTitle,
  durationMinutes,
  onComplete,
}: {
  testId: string;
  testTitle: string;
  durationMinutes: number;
  onComplete: () => void;
}) => {
  const { user } = useAuth();
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Map<string, string[]>>(new Map());
  const [currentQuestion, setCurrentQuestion] = useState(0);
  const [timeRemaining, setTimeRemaining] = useState(durationMinutes * 60);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const startTimeRef = useRef<Date>(new Date());
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const autoSubmitRef = useRef(false);

  useEffect(() => {
    loadTest();
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!loading && timeRemaining > 0) {
      timerRef.current = setInterval(() => {
        setTimeRemaining((prev) => {
          if (prev <= 1) {
            if (timerRef.current) clearInterval(timerRef.current);
            autoSubmitRef.current = true;
            handleSubmit(true);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);

      return () => {
        if (timerRef.current) {
          clearInterval(timerRef.current);
        }
      };
    }
  }, [loading]);

  const loadTest = async () => {
    const [questionsResult, attemptResult] = await Promise.all([
      supabase
        .from('questions')
        .select('*')
        .eq('test_id', testId)
        .order('order_index'),
      supabase
        .from('test_attempts')
        .select('*')
        .eq('test_id', testId)
        .eq('user_id', user?.id)
        .eq('status', 'in_progress')
        .maybeSingle(),
    ]);

    if (questionsResult.data) {
      setQuestions(questionsResult.data);
    }

    if (attemptResult.data) {
      setAttemptId(attemptResult.data.id);
      startTimeRef.current = new Date(attemptResult.data.started_at);

      const existingAnswers = await supabase
        .from('attempt_answers')
        .select('*')
        .eq('attempt_id', attemptResult.data.id);

      if (existingAnswers.data) {
        const answersMap = new Map();
        existingAnswers.data.forEach((ans) => {
          if (ans.selected_answers) {
            answersMap.set(ans.question_id, ans.selected_answers);
          }
        });
        setAnswers(answersMap);
      }

      const elapsed = Math.floor((Date.now() - new Date(attemptResult.data.started_at).getTime()) / 1000);
      const remaining = Math.max(0, durationMinutes * 60 - elapsed);
      setTimeRemaining(remaining);

      if (remaining <= 0) {
        autoSubmitRef.current = true;
        handleSubmit(true);
        return;
      }
    }

    setLoading(false);
  };

  const handleAnswerChange = async (questionId: string, optionId: string, isMultiple: boolean) => {
    const newAnswers = new Map(answers);

    if (isMultiple) {
      const current = newAnswers.get(questionId) || [];
      if (current.includes(optionId)) {
        const filtered = current.filter((id) => id !== optionId);
        if (filtered.length === 0) {
          newAnswers.delete(questionId);
        } else {
          newAnswers.set(questionId, filtered);
        }
      } else {
        newAnswers.set(questionId, [...current, optionId]);
      }
    } else {
      newAnswers.set(questionId, [optionId]);
    }

    setAnswers(newAnswers);

    if (attemptId) {
      const selectedAnswers = newAnswers.get(questionId) || null;

      await supabase
        .from('attempt_answers')
        .upsert(
          {
            attempt_id: attemptId,
            question_id: questionId,
            selected_answers: selectedAnswers,
            is_correct: false,
            marks_obtained: 0,
          },
          {
            onConflict: 'attempt_id,question_id',
          }
        );
    }
  };

  const calculateScore = () => {
    let totalScore = 0;
    const scoredAnswers: any[] = [];

    questions.forEach((question) => {
      const userAnswer = answers.get(question.id);
      if (!userAnswer) {
        scoredAnswers.push({
          question_id: question.id,
          selected_answers: null,
          is_correct: false,
          marks_obtained: 0,
        });
        return;
      }

      const correctAnswers = question.correct_answers.sort();
      const userAnswerSorted = [...userAnswer].sort();
      const isCorrect =
        correctAnswers.length === userAnswerSorted.length &&
        correctAnswers.every((val, idx) => val === userAnswerSorted[idx]);

      const marks = isCorrect ? question.marks : 0;
      totalScore += marks;

      scoredAnswers.push({
        question_id: question.id,
        selected_answers: userAnswer,
        is_correct: isCorrect,
        marks_obtained: marks,
      });
    });

    return { totalScore, scoredAnswers };
  };

  const handleSubmit = async (isAutoSubmit = false) => {
    if (submitting) return;

    setSubmitting(true);

    if (timerRef.current) {
      clearInterval(timerRef.current);
    }

    try {
      const endTime = new Date();
      const timeTaken = Math.floor((endTime.getTime() - startTimeRef.current.getTime()) / 1000);
      const { totalScore, scoredAnswers } = calculateScore();

      if (attemptId) {
        await supabase
          .from('test_attempts')
          .update({
            submitted_at: endTime.toISOString(),
            time_taken_seconds: timeTaken,
            score: totalScore,
            status: isAutoSubmit ? 'auto_submitted' : 'submitted',
          })
          .eq('id', attemptId);

        for (const answer of scoredAnswers) {
          await supabase
            .from('attempt_answers')
            .upsert(
              {
                attempt_id: attemptId,
                ...answer,
              },
              {
                onConflict: 'attempt_id,question_id',
              }
            );
        }
      }

      onComplete();
    } catch (error) {
      setSubmitting(false);
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const getAnsweredCount = () => {
    return answers.size;
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-4 border-blue-600 border-t-transparent mb-4"></div>
          <p className="text-slate-600">Loading test...</p>
        </div>
      </div>
    );
  }

  if (submitting) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-4 border-blue-600 border-t-transparent mb-4"></div>
          <p className="text-slate-600">
            {autoSubmitRef.current ? 'Time is up! Submitting test...' : 'Submitting test...'}
          </p>
        </div>
      </div>
    );
  }

  const currentQ = questions[currentQuestion];
  const isMultiple = currentQ?.question_type === 'multiple_correct';
  const userAnswer = answers.get(currentQ?.id || '') || [];

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="bg-white border-b border-slate-200 sticky top-0 z-10 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-xl font-bold text-slate-900">{testTitle}</h1>
              <p className="text-sm text-slate-600">
                Question {currentQuestion + 1} of {questions.length} · Answered: {getAnsweredCount()}/
                {questions.length}
              </p>
            </div>
            <div className="flex items-center gap-6">
              <div
                className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium ${timeRemaining < 300
                    ? 'bg-red-100 text-red-700'
                    : timeRemaining < 600
                      ? 'bg-orange-100 text-orange-700'
                      : 'bg-blue-100 text-blue-700'
                  }`}
              >
                <Clock className="w-5 h-5" />
                {formatTime(timeRemaining)}
              </div>
              <button
                onClick={() => handleSubmit(false)}
                className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium"
              >
                Submit Test
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {timeRemaining < 300 && (
          <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-red-900">Time is running out!</p>
              <p className="text-sm text-red-700">
                Less than 5 minutes remaining. The test will auto-submit when time expires.
              </p>
            </div>
          </div>
        )}

        <div className="bg-white rounded-xl shadow-sm p-8 mb-6">
          <div className="mb-6">
            <div className="flex items-start gap-3 mb-4">
              <span className="flex-shrink-0 w-8 h-8 bg-blue-600 text-white rounded-lg flex items-center justify-center font-semibold">
                {currentQuestion + 1}
              </span>
              <div className="flex-1">
                <pre className="text-lg text-slate-900 whitespace-pre-wrap font-mono bg-slate-100 p-4 rounded-lg overflow-x-auto">
                  {currentQ.question_text}
                </pre>
                <div className="flex items-center gap-4 mt-2">
                  <span className="text-sm text-slate-600">Marks: {currentQ.marks}</span>
                  {isMultiple && (
                    <span className="text-sm bg-orange-100 text-orange-700 px-2 py-1 rounded">
                      Multiple Correct
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            {currentQ.options.map((option) => {
              const isSelected = userAnswer.includes(option.id);
              return (
                <label
                  key={option.id}
                  className={`flex items-center p-4 border-2 rounded-lg cursor-pointer transition-all ${isSelected
                      ? 'border-blue-600 bg-blue-50'
                      : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                    }`}
                >
                  <input
                    type={isMultiple ? 'checkbox' : 'radio'}
                    name={`question-${currentQ.id}`}
                    checked={isSelected}
                    onChange={() => handleAnswerChange(currentQ.id, option.id, isMultiple)}
                    className="w-5 h-5 mr-4"
                  />
                  <span className="text-slate-900">{option.text}</span>
                  {isSelected && <CheckCircle className="w-5 h-5 text-blue-600 ml-auto" />}
                </label>
              );
            })}
          </div>
        </div>

        <div className="flex justify-between items-center">
          <button
            onClick={() => setCurrentQuestion(Math.max(0, currentQuestion - 1))}
            disabled={currentQuestion === 0}
            className="px-6 py-3 border-2 border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
          >
            Previous
          </button>

          <div className="flex gap-2">
            {questions.map((_, idx) => (
              <button
                key={idx}
                onClick={() => setCurrentQuestion(idx)}
                className={`w-10 h-10 rounded-lg font-medium transition-colors ${idx === currentQuestion
                    ? 'bg-blue-600 text-white'
                    : answers.has(questions[idx].id)
                      ? 'bg-green-100 text-green-700 hover:bg-green-200'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
              >
                {idx + 1}
              </button>
            ))}
          </div>

          <button
            onClick={() =>
              setCurrentQuestion(Math.min(questions.length - 1, currentQuestion + 1))
            }
            disabled={currentQuestion === questions.length - 1}
            className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
};
